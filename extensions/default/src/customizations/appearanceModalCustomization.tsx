import React from 'react';
import {
  AppearanceModal,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Button,
  useActiveTheme,
} from '@ohif/ui-next';
import { useTranslation } from 'react-i18next';

function AppearanceModalDefault() {
  // Theme PRESETS are intentionally not offered: this viewer ships one palette,
  // contrast-checked against DICOM greys (see tailwind.css). The upstream picker
  // let a radiologist switch to e.g. the purple 'orchid' preset mid-report, on a
  // palette nobody validated for reading grayscale. `setActiveTheme` is no longer
  // consumed here for that reason; custom CSS remains for support/debug use.
  const { activeTheme, customCss, applyCustomTheme, clearCustomTheme } = useActiveTheme();
  const { t } = useTranslation('AppearanceModal');

  const [draftCss, setDraftCss] = React.useState(() => customCss);
  const [isCustomOpen, setIsCustomOpen] = React.useState(() => activeTheme === 'custom');
  const [parseFailed, setParseFailed] = React.useState(false);

  const handleToggleCustom = () => {
    setIsCustomOpen(!isCustomOpen);
  };

  const handleSave = () => {
    setParseFailed(!applyCustomTheme(draftCss));
  };

  const handleClear = () => {
    clearCustomTheme();
    setDraftCss('');
    setParseFailed(false);
    setIsCustomOpen(false);
  };

  const handlePresetChange = (value: string) => {
    if (value === 'custom') {
      // Selecting "Custom" restores the saved custom theme; the draft is only
      // committed through the explicit Apply button.
      setIsCustomOpen(true);
      if (customCss) {
        applyCustomTheme(customCss);
      }
    } else {
      setIsCustomOpen(false);
    }
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraftCss(e.target.value);
    setParseFailed(false);
  };

  return (
    <AppearanceModal>
      <AppearanceModal.Body>
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-4">
          <AppearanceModal.SectionLabel>{t('Theme')}</AppearanceModal.SectionLabel>
          <div>
            <Select
              value={activeTheme}
              onValueChange={handlePresetChange}
            >
              <SelectTrigger
                className="w-[200px]"
                aria-label={t('Theme')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* Presets removed on purpose — one validated palette only.
                    See the note where useActiveTheme is destructured. */}
                <SelectItem value="default">{t('Default Theme')}</SelectItem>
                {(customCss || draftCss) && <SelectItem value="custom">{t('Custom')}</SelectItem>}
              </SelectContent>
            </Select>
          </div>

          <div className="col-start-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleToggleCustom}
            >
              {isCustomOpen ? t('Hide') : t('Custom Theme')}
            </Button>
          </div>
        </div>

        {isCustomOpen && (
          <div className="mt-4 flex flex-col space-y-2">
            <textarea
              value={draftCss}
              onChange={handleTextChange}
              placeholder={t('Paste your custom theme color tokens here')}
              aria-label={t('Paste your custom theme color tokens here')}
              rows={8}
              className="bg-muted text-foreground border-input placeholder:text-muted-foreground focus:ring-ring rounded-md border px-3 py-2 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-inset"
            />
            {parseFailed && (
              <span
                className="text-destructive text-sm"
                role="alert"
              >
                {t('No valid theme tokens found')}
              </span>
            )}
            <div className="flex space-x-2">
              <Button
                variant="default"
                size="sm"
                onClick={handleSave}
              >
                {t('Apply')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClear}
              >
                {t('Clear')}
              </Button>
            </div>
          </div>
        )}
      </AppearanceModal.Body>
    </AppearanceModal>
  );
}

export default {
  'ohif.appearanceModal': AppearanceModalDefault,
};
