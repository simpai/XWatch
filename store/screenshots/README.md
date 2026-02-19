# Store Screenshots

Generated PNG files for store upload (1280x800):

- `01-overview-ko.png`
- `02-profile-memo-ko.png`
- `03-timeline-note-ko.png`
- `04-schedule-shortcuts-ko.png`
- `05-options-viewer-ko.png`
- `01-overview-en.png`
- `02-profile-memo-en.png`
- `03-timeline-note-en.png`
- `04-schedule-shortcuts-en.png`
- `05-options-viewer-en.png`

Source templates:

- `templates/01-overview-ko.html`
- `templates/02-profile-memo-ko.html`
- `templates/03-timeline-note-ko.html`
- `templates/04-schedule-shortcuts-ko.html`
- `templates/05-options-viewer-ko.html`
- `templates/01-overview-en.html`
- `templates/02-profile-memo-en.html`
- `templates/03-timeline-note-en.html`
- `templates/04-schedule-shortcuts-en.html`
- `templates/05-options-viewer-en.html`
- `templates/style.css`

Regenerate examples:

```powershell
npx playwright screenshot --viewport-size="1280,800" file:///S:/Projects/XWatch/store/screenshots/templates/01-overview-ko.html store/screenshots/01-overview-ko.png
```
