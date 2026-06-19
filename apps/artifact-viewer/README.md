# Artifact Viewer

Local, generated HTML viewer for the Apple Glass parity lab.

Current entry points:

```bash
npm run glass:inspect -- <capture.json|baseline.json|artifact-id>
npm run glass:diff -- --reference <capture.json|artifact-id> --candidate <capture.json|artifact-id>
```

The viewer is intentionally static and self-contained for now: PNG frames are
embedded as data URIs, and the diff heatmap is computed in the browser from the
embedded reference/candidate frames. That keeps captured artifact folders
portable while the app-side capture path is still changing.

Current scope:

```text
artifact identity
baseline namespace
null qualification status
G2 static metric summary
G3 optics summary
G4 temporal summary
debug heatmap
energy summary when present
identifiability tags when present
raw artifact/baseline JSON
```
