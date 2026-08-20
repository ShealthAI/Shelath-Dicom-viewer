import {
  assessVolumeFeasibility,
  findAvailableReformats,
} from './assessVolumeFeasibility';
import { _resetGpuTierCache } from './getGpuTier';

/**
 * The property under test is a clinical one, not a performance one:
 *
 *   a volume is built from EVERY slice, or it is not built at all.
 *
 * There is no middle option where the radiologist is shown a reconstruction
 * quietly missing images, because a finding smaller than the slice gap could be
 * invisible in it.
 */

const displaySet = ({ rows = 512, columns = 512, bits = 16 } = {}) => ({
  instances: [{ Rows: rows, Columns: columns, BitsAllocated: bits }],
});
const ids = (n: number) => Array.from({ length: n }, (_, i) => `wadors:instance-${i}`);

function onDevice(tier: 'low' | 'mid' | 'high') {
  _resetGpuTierCache();
  window.history.replaceState({}, '', `/?gpuTier=${tier}`);
}

describe('assessVolumeFeasibility', () => {
  afterEach(() => {
    _resetGpuTierCache();
    window.history.replaceState({}, '', '/');
  });

  it('NEVER returns a reduced image list — the API cannot drop slices', () => {
    onDevice('low');
    const result = assessVolumeFeasibility(displaySet(), ids(2518));
    // The result carries a verdict, not a modified series. There is no code path
    // by which a caller receives fewer images than the scanner produced.
    expect(Object.keys(result)).not.toContain('imageIds');
    expect(result.slices).toBe(2518);
  });

  describe('the hard texture-size wall', () => {
    it('blocks a 2518-slice series that exceeds MAX_3D_TEXTURE_SIZE', () => {
      onDevice('high'); // even a workstation cannot exceed the texture axis cap
      const result = assessVolumeFeasibility(displaySet(), ids(2518));

      expect(result.verdict).toBe('exceeds-texture-limit');
      expect(result.feasible).toBe(false);
      expect(result.reason).toMatch(/caps a 3D texture axis/);
    });

    it('explains it in language a radiologist can act on', () => {
      onDevice('high');
      const { userMessage } = assessVolumeFeasibility(displaySet(), ids(2518));

      expect(userMessage).toMatch(/full resolution/i);
      expect(userMessage).not.toMatch(/texture|GPU|WebGL|buffer/i);
    });
  });

  describe('the soft memory budget', () => {
    it('blocks a series that fits the texture cap but not this GPU memory', () => {
      onDevice('low');
      const result = assessVolumeFeasibility(displaySet(), ids(1200));

      expect(result.verdict).toBe('exceeds-memory');
      expect(result.feasible).toBe(false);
      expect(result.userMessage).toMatch(/1200 images/);
      expect(result.userMessage).toMatch(/full resolution/);
    });

    it('allows the same series on a workstation', () => {
      onDevice('high');
      const result = assessVolumeFeasibility(displaySet(), ids(1200));

      expect(result.verdict).toBe('ok');
      expect(result.feasible).toBe(true);
      expect(result.userMessage).toBeNull();
    });
  });

  it('allows an ordinary series on the weakest device', () => {
    onDevice('low');
    const result = assessVolumeFeasibility(displaySet(), ids(200));
    expect(result.feasible).toBe(true);
    expect(result.verdict).toBe('ok');
  });

  describe('only mentions server reformats when the study actually has them', () => {
    // Sending a radiologist to a series that does not exist is worse than saying
    // nothing: they search an empty study list and conclude we are broken.
    it('stays silent about COR/SAG when the reformat job has not run', () => {
      onDevice('low');
      const result = assessVolumeFeasibility(displaySet(), ids(2518));
      expect(result.userMessage).not.toMatch(/COR MPR|SAG MPR/);
      expect(result.userMessage).toMatch(/full resolution/);
    });

    it('names both planes when both series are present', () => {
      onDevice('low');
      const result = assessVolumeFeasibility(displaySet(), ids(2518), {
        coronal: true,
        sagittal: true,
      });
      expect(result.userMessage).toMatch(/"COR MPR" or "SAG MPR"/);
    });

    it('names only the plane that exists', () => {
      onDevice('low');
      const result = assessVolumeFeasibility(displaySet(), ids(2518), {
        coronal: true,
        sagittal: false,
      });
      expect(result.userMessage).toMatch(/"COR MPR"/);
      expect(result.userMessage).not.toMatch(/SAG MPR/);
    });
  });

  describe('findAvailableReformats', () => {
    it('detects the series the ingest job writes', () => {
      const found = findAvailableReformats([
        { SeriesDescription: 'COR MPR (derived)', SeriesNumber: 9001,
          instances: [{ ImageType: ['DERIVED', 'SECONDARY', 'REFORMATTED'] }] },
        { SeriesDescription: 'SAG MPR (derived)', SeriesNumber: 9002,
          instances: [{ ImageType: ['DERIVED', 'SECONDARY', 'REFORMATTED'] }] },
      ]);
      expect(found).toEqual({ coronal: true, sagittal: true });
    });

    it('does not mistake an acquired series for a reformat', () => {
      const found = findAvailableReformats([
        { SeriesDescription: 'Thorax 1.00 Br40', SeriesNumber: 3,
          instances: [{ ImageType: ['ORIGINAL', 'PRIMARY', 'AXIAL'] }] },
      ]);
      expect(found).toEqual({ coronal: false, sagittal: false });
    });

    it('captures the display set UIDs so the message can offer a one-click open', () => {
      // Without the UID the best the notification can do is name the series and
      // leave the radiologist to hunt for it mid-report.
      const found = findAvailableReformats([
        { SeriesDescription: 'COR MPR (derived)', SeriesNumber: 9001,
          displaySetInstanceUID: 'ds-cor',
          instances: [{ ImageType: ['DERIVED', 'SECONDARY', 'REFORMATTED'] }] },
        { SeriesDescription: 'SAG MPR (derived)', SeriesNumber: 9002,
          displaySetInstanceUID: 'ds-sag',
          instances: [{ ImageType: ['DERIVED', 'SECONDARY', 'REFORMATTED'] }] },
      ]);
      expect(found.coronalDisplaySetUID).toBe('ds-cor');
      expect(found.sagittalDisplaySetUID).toBe('ds-sag');
    });

    it('keeps the first matching series when a study has duplicates', () => {
      // Re-ingested or re-pushed studies can carry two copies. Sending the
      // radiologist to a stable one beats whichever happened to sort last.
      const found = findAvailableReformats([
        { SeriesDescription: 'COR MPR (derived)', SeriesNumber: 9001,
          displaySetInstanceUID: 'ds-cor-1',
          instances: [{ ImageType: ['DERIVED', 'SECONDARY', 'REFORMATTED'] }] },
        { SeriesDescription: 'COR MPR (derived)', SeriesNumber: 9001,
          displaySetInstanceUID: 'ds-cor-2',
          instances: [{ ImageType: ['DERIVED', 'SECONDARY', 'REFORMATTED'] }] },
      ]);
      expect(found.coronalDisplaySetUID).toBe('ds-cor-1');
    });

    it('reports availability even when the UID is absent', () => {
      // Detection and navigation are separate concerns: a series with no UID is
      // still worth naming in the message, just not clickable.
      const found = findAvailableReformats([
        { SeriesDescription: 'COR MPR (derived)', SeriesNumber: 9001,
          instances: [{ ImageType: ['DERIVED', 'SECONDARY', 'REFORMATTED'] }] },
      ]);
      expect(found.coronal).toBe(true);
      expect(found.coronalDisplaySetUID).toBeUndefined();
    });

    it('survives an empty or missing study list', () => {
      expect(findAvailableReformats([])).toEqual({ coronal: false, sagittal: false });
      // @ts-expect-error deliberately passing nothing
      expect(findAvailableReformats(undefined)).toEqual({ coronal: false, sagittal: false });
    });
  });

  describe('when metadata is missing', () => {
    it('does not block the radiologist on a guess', () => {
      onDevice('low');
      const result = assessVolumeFeasibility({ instances: [] }, ids(2518));

      // Blocking MPR because we could not read Rows/Columns would deny a
      // capability the device may well have. The context-loss handler remains
      // the safety net for this case.
      expect(result.verdict).toBe('unknown');
      expect(result.feasible).toBe(true);
      expect(result.userMessage).toBeNull();
    });
  });
});
