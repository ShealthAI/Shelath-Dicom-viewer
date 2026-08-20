import { getWebWorkerManager, imageLoader, metaData } from '@cornerstonejs/core';

import { NotReformattable, deriveVolumeGeometry } from './deriveVolumeGeometry';
import { assessCpuReformat, readDeviceMemoryGb } from './assessCpuReformat';
import { bytesPerVoxel, harvestSeries, type PixelDescriptor } from './harvestSliceMetadata';
import { planeCount, planeGeometry, type Plane, type VolumeGeometry } from './reformatEngine';

/**
 * Assembles a series into a volume held by the reformat worker, then serves
 * coronal and sagittal planes from it on demand.
 *
 * ON DEMAND, NOT UP FRONT. Measured on a 512x512x761 CT, one coronal plane
 * costs ~5 ms and one sagittal ~14 ms, so computing the plane being looked at
 * is imperceptible, while precomputing both full series would be several
 * seconds of waiting for planes the radiologist may never scroll to.
 *
 * The expensive part is not the reslicing, it is getting the pixels. Slices
 * already in Cornerstone's cache cost nothing; the rest are fetched exactly as
 * scrolling the series would fetch them.
 */

const WORKER_NAME = 'shealth-reformat-worker';

let workerRegistered = false;

function ensureWorkerRegistered(): void {
  if (workerRegistered) {
    return;
  }
  getWebWorkerManager().registerWorker(
    WORKER_NAME,
    () =>
      new Worker(new URL('./reformatWorker.js', import.meta.url), {
        name: WORKER_NAME,
      }),
    {
      // Both of these matter, and neither matches the defaults used elsewhere.
      //
      // ONE INSTANCE: the worker holds the volume as module state. With a pool,
      // a later call could be routed to an instance that has never seen the
      // study and would answer "extract before begin".
      maxWorkerInstances: 1,
      // NO AUTO-TERMINATE: the stock options kill an idle worker after a
      // second, which here would silently discard the volume between the
      // radiologist assembling it and scrolling to the next plane.
      autoTerminateOnIdle: { enabled: false, idleTimeThreshold: 0 },
    }
  );
  workerRegistered = true;
}

export interface ReformatProgress {
  loaded: number;
  total: number;
}

export interface ReformatSessionOptions {
  imageIds: string[];
  /** Slab thickness in mm; 3 mm matches the server reformatter's default. */
  thicknessMm?: number;
  signal?: AbortSignal;
  onProgress?: (progress: ReformatProgress) => void;
  /** Concurrent image fetches. Matches the viewer's own stack prefetch width. */
  concurrency?: number;
}

export interface ReformatPlaneImage {
  pixels: ArrayBufferView;
  width: number;
  height: number;
}

export interface ReformatSession {
  geometry: VolumeGeometry;
  pixel: PixelDescriptor;
  thicknessMm: number;
  planeCount(plane: Plane): number;
  planeGeometry(plane: Plane): ReturnType<typeof planeGeometry>;
  extract(plane: Plane, index: number): Promise<ReformatPlaneImage>;
  dispose(): Promise<void>;
}

export class ReformatAborted extends Error {
  constructor() {
    super('reformat cancelled');
    this.name = 'ReformatAborted';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ReformatAborted();
  }
}

/**
 * Run `worker` over `items` with a bounded number in flight.
 *
 * Bounded rather than Promise.all: firing 761 image requests at once buries the
 * connection pool and makes the study the radiologist is actually scrolling
 * compete with the reformat for bandwidth.
 */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      throwIfAborted(signal);
      const index = cursor++;
      if (index >= items.length) {
        return;
      }
      await worker(items[index], index);
    }
  });

  await Promise.all(runners);
}

/**
 * Build a session, or throw NotReformattable with a reason worth showing.
 *
 * Order matters: geometry is validated and memory checked BEFORE a single
 * pixel is fetched, so a study that cannot work fails in milliseconds rather
 * than after a minute of downloading.
 */
export async function createReformatSession(
  options: ReformatSessionOptions
): Promise<ReformatSession> {
  const { imageIds, thicknessMm = 3, signal, onProgress, concurrency = 6 } = options;

  throwIfAborted(signal);

  const { planes, pixel } = harvestSeries(metaData as never, imageIds);
  const derived = deriveVolumeGeometry(planes);

  const assessment = assessCpuReformat(
    derived.geometry,
    bytesPerVoxel(pixel),
    readDeviceMemoryGb()
  );
  if (!assessment.feasible) {
    throw new NotReformattable(assessment.reason);
  }

  ensureWorkerRegistered();
  const manager = getWebWorkerManager();

  await manager.executeTask(WORKER_NAME, 'begin', {
    geometry: derived.geometry,
    bitsAllocated: pixel.bitsAllocated,
    pixelRepresentation: pixel.pixelRepresentation,
  });

  let disposed = false;
  const dispose = async () => {
    if (disposed) {
      return;
    }
    disposed = true;
    // Best effort: a worker that has already gone away has nothing to free,
    // and failing to dispose must never surface to the radiologist.
    try {
      await manager.executeTask(WORKER_NAME, 'end', {});
    } catch {
      /* already gone */
    }
  };

  try {
    let loaded = 0;

    // derived.order maps stacking position -> index in the caller's imageIds.
    // Iterating it rather than imageIds is what puts each slice at its correct
    // depth: images complete out of order, and arrival order would interleave
    // the patient.
    await mapWithConcurrency(
      derived.order,
      concurrency,
      async (sourceIndex, position) => {
        const image = await imageLoader.loadAndCacheImage(imageIds[sourceIndex]);
        throwIfAborted(signal);

        // A tight copy, never the cached array itself.
        //
        // Cornerstone's worker manager offers no transferable path, so the
        // argument is structured-cloned on the way across - which is the safe
        // behaviour here anyway: transferring would detach the buffer and empty
        // the viewer's own image cache for that slice. `slice()` first because
        // decoded pixel data can be a view into a larger buffer, and cloning a
        // view copies the whole buffer behind it.
        //
        // The cost is a memcpy of one slice, about half a megabyte. Across a
        // 761-slice CT that is a fraction of a second in total, against the
        // tens of seconds the same series takes to arrive over the network.
        const source = image.getPixelData() as ArrayBufferView & { slice(): ArrayBufferView };
        const pixels = source.slice();

        await manager.executeTask(WORKER_NAME, 'addSlice', { index: position, pixels });

        loaded += 1;
        onProgress?.({ loaded, total: derived.order.length });
      },
      signal
    );

    throwIfAborted(signal);

    const missing = (await manager.executeTask(WORKER_NAME, 'missingSlices', {})) as number[];
    if (missing?.length) {
      // A volume with holes reformats into an image with blank bands that look
      // like anatomy. Refusing is the only safe answer.
      throw new NotReformattable(`${missing.length} slices failed to load`);
    }
  } catch (error) {
    await dispose();
    throw error;
  }

  return {
    geometry: derived.geometry,
    pixel,
    thicknessMm,
    planeCount: (plane: Plane) => planeCount(derived.geometry, plane, thicknessMm),
    planeGeometry: (plane: Plane) => planeGeometry(derived.geometry, plane, thicknessMm),
    extract: async (plane: Plane, index: number) => {
      if (disposed) {
        throw new NotReformattable('reformat session has been released');
      }
      return (await manager.executeTask(WORKER_NAME, 'extract', {
        plane,
        index,
        thicknessMm,
      })) as ReformatPlaneImage;
    },
    dispose,
  };
}
