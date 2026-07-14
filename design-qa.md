# Knowledge Core design QA

- source visual truth path: `C:\Users\linzy\.codex\generated_images\019f5b3c-3072-77e0-a2a1-04c3dc947d18\exec-cbbf238d-1376-48a1-a6cb-401a583a6a8b.png`
- current implementation screenshots:
  - knowledge: `C:\Users\linzy\AppData\Local\Temp\codex-clipboard-2ddf5601-962b-4df7-b1c4-8b527d4ae330.png`
  - search: `C:\Users\linzy\AppData\Local\Temp\codex-clipboard-857be277-37eb-4c74-ac17-5d158e5c5be0.png`
  - proposals: `C:\Users\linzy\AppData\Local\Temp\codex-clipboard-7b98de45-c91e-4a9b-bd0c-d98968e45cc7.png`
  - tokens: `C:\Users\linzy\AppData\Local\Temp\codex-clipboard-7b1403af-9589-4e88-8fc3-590c41fe6d87.png`
  - jobs: `C:\Users\linzy\AppData\Local\Temp\codex-clipboard-8c7aad98-f1e1-4a19-8021-c27167e993d4.png`
- source viewport: 1487 x 1058
- implementation captures: approximately 2559 x 1440; browser chrome excluded from the comparison
- state: authenticated desktop workspace with populated collections and an automatically selected document

## Full-view comparison evidence

The source and all five refreshed implementation screenshots were opened together in one comparison input. The implementation now matches the source's core composition: compact product rail, populated document navigation, active editor/preview canvas, and contextual traceability inspector. The supporting operational views share the same white canvas, restrained indigo accent, compact controls, border rhythm, and data density.

The refreshed knowledge screenshot confirms that entering a populated collection opens the first visible document and exposes the main editor immediately. The refreshed proposals screenshot confirms that the review surface fits inside the viewport without the earlier page scrollbar. The final search screenshot confirms that collection filters remain on one row, local overflow stays inside the chip strip, and the browser-level horizontal scrollbar is gone.

## Focused region comparison evidence

- Knowledge navigation and canvas: an active note, split Markdown/preview state, selected list row, indexing metadata, and contextual source data are all visible. This resolves the earlier empty primary-canvas mismatch.
- Search filter strip and viewport edge: the chips remain on one line, the right-side tag and result-count controls stay visible, and no browser-level horizontal scrollbar remains.
- Proposal lower edge: the full rounded surface and lower page margin are visible with no scrollbar, resolving the previous viewport overflow.
- Tokens and jobs: typography, table density, icon treatment, spacing, and status colors remain consistent with the selected direction.
- No raster product imagery is present in the source or implementation. Icons use installed icon libraries; no placeholder imagery or custom SVG/CSS asset substitutions are visible.

## Required fidelity surfaces

- Fonts and typography: Chinese sans-serif hierarchy, mono metadata, bold page titles, truncation, and compact supporting text are consistent. Long E2E data truncates without breaking the grid.
- Spacing and layout rhythm: the rail and primary content proportions are stable. Knowledge, proposal height, search filter wrapping, and search shell overflow are all resolved in the refreshed captures.
- Colors and visual tokens: white and cool-gray surfaces, indigo selected/primary states, green completion states, and subtle border tokens are consistent across all screens.
- Image quality and asset fidelity: no raster image assets are required. Library icons render sharply and consistently.
- Copy and content: the knowledge, retrieval, memory review, token, and indexing workflows are clearly named. Test fixture names add noise but do not obstruct controls or meaning.

## Findings

No actionable P0, P1, or P2 findings remain. The final search capture provides the missing post-fix evidence: the page stays within the viewport, the filter chips remain single-line, and fixed search controls remain accessible.

## Comparison history

1. Initial visual pass
   - [P1] Populated collection did not automatically open a document.
   - [P2] Search collection filters wrapped into a dense two-row block.
   - [P2] Proposal review view exceeded the viewport and caused page scrolling.
2. First fix pass and refreshed evidence
   - The first document now opens automatically; confirmed in the refreshed knowledge screenshot.
   - Collection filters now remain on one row; confirmed in the refreshed search screenshot.
   - Proposal minimum height was reduced; confirmed by the full surface and absent scrollbar in the refreshed proposal screenshot.
   - A new [P2] browser-level horizontal overflow became visible in the refreshed search screenshot.
3. Second fix pass
   - The app shell is now capped to `100vw` and clips accidental outer overflow.
   - The search filter group now uses a zero flex basis and explicit width constraints, keeping only the chip strip locally scrollable.
   - Frontend tests, typecheck, Vite build, and Worker dry-run pass.
4. Final visual evidence
   - The final search screenshot shows no browser-level horizontal scrollbar.
   - Collection chips stay on one row without pushing the tag and count controls outside the surface.
   - No new P0/P1/P2 issue is visible; the visual gate passes.

## Implementation checklist

- [x] Automatically open the first document in a populated collection.
- [x] Keep search collection filters in a single scrollable row.
- [x] Fit the proposal review surface within the desktop viewport.
- [x] Constrain the search view and app shell to the viewport width.
- [x] Run frontend tests, typecheck, and production build after the final CSS fix.
- [x] Capture and compare one final search screenshot.

## Follow-up polish

- [P3] Periodically remove stale E2E fixtures from shared development data so realistic names dominate screenshots and demos.

## Final result

final result: passed
