# Apple Glass Parity Lab — Execution Plan v1.2

## DELTA v1.1 → v1.2

- Каркас v1.1 не тронут. v1.2 закрывает доктринальные дыры и два логических бага.
- Добавлен flat-null self-test как фундамент: pipeline-qualification (полная лестница) + per-capture sentinel внутри G1.
- Null не "byte-equivalent". byte-equal только на flat-grey и hard-edge rung. градиентный rung structural-flat после Noise Separator. дизер Apple не байт-плоский.
- Null гонится по каждой candidate-дороге отдельно: WebGL drawing buffer и WKWebView CSS compositing — разные цветовые пути.
- Добавлена сцена S00 = null passthrough.
- Identifiability вшита в solver: лучшее из godhand. degenerate-фит не выбрасывается, ему запрещается parameter-level overclaim.
- Degeneracy-breaking фоны (S07–S11) выведены из-под G7-карантина в solver loss. солвер теперь их видит.
- Solver loss суммируется по background sweep, не по одному фону.
- shader_threshold отвязан от webkit_gap. C1 меряется против R0; webkit_gap нёс слепые зоны WebKit. webkit_gap оставлен report-only флором.
- Optional difficulty-scaling, если нужен, берётся из контент-статистики R0, не из R1.
- Магические множители 1.05/1.10 заменены именованными SHADER_SLACK/WEBKIT_SLACK с owner и деривацией.
- VerdictClass разнесён на две оси: TechnicalClass (parity level) и VerdictClass (disposition). VERDICT_CLASS в репорте больше не несёт parity-токен.
- Gesture single-source сделан явным инвариантом. XCUITest/WebDriver — consumers одной траектории, не авторы. валиден byte-identical source, не delivered events.
- System glass reference обязан сниматься на compositor level. layer-snapshot (drawHierarchy/UIGraphicsImageRenderer) запрещён — не видит живой backdrop.
- Perceptual metric обязан работать внутри залоченного linear Display P3. иначе G1 обнуляется внутри G2.
- repeat_n=300 ограничен fast per-frame метриками. sustained/energy baseline получил repeat_n_sustained. baseline capture требует thermal_state_start = nominal + enforced cooldown.
- Highlight Probe учитывает SDR-клип яркого specular.
- schema_version 1.1.0 → 1.2.0. transfer_function заменён на stored_transfer ('srgb-transfer' only для iOS screenshot).
- INVALID и INVALID_FOR_VERDICT унифицированы в один терминал INVALID с reason-кодом.
- Процедурные сцены кеются content_seed, asset-сцены — background_asset_hash.

## ДЕФЕКТ

- v1.0 уже убрал главный яд.
- Главный яд был субъективный глазомер.
- v1.0 уже зафиксировал physical truth.
- v1.0 уже запретил simulator verdict.
- v1.0 уже отделил WebKit route от SwiftUI parity.
- v1.0 уже ввел perceptual metrics.
- v1.0 уже ввел color lock.
- v1.0 уже ввел black-box solver.
- v1.0 уже ввел baked shader verdict.
- v1.0 уже ввел CI gate.
- v1.1 нужен не для смены архитектуры.
- v1.1 нужен для убийства долгосрочной деградации.
- Технический PASS не равен продуктовой пригодности.
- FLIP не знает, дорогой ли выглядит материал.
- SSIM не знает, читается ли интерфейс в реальном сценарии.
- OKLab не знает, раздражает ли стекло на busy-фоне.
- Optics probes не знают, уместен ли эффект в продуктовой иерархии.
- Human review как вкус опасен.
- Human review как structured gate обязателен.
- G7 нельзя оставлять свободным мнением.
- G7 должен иметь артефакты, категории блокировки и владельцев.
- `n >= 50` недостаточно для честного P99 verdict.
- `n >= 50` годится как MVL floor.
- Для P99 production нужен более толстый хвост выборки.
- Выбросы нельзя молча удалять.
- Выбросы надо классифицировать.
- Thermal spike не равен product regression.
- Background process не равен shader regression.
- Metric noise не равен visual pass.
- Baseline без iOS build versioning протухает тихо.
- Apple может менять стекло между minor-build релизами.
- Один хороший кадр не гарантирует долгой работы.
- Glass может пройти p95 frame time и сжечь батарею.
- Glass может пройти короткий test и умереть через 45 секунд throttling.
- Telegram Mini App может держать glass на экране долго.
- Runtime gate без energy gate неполон.
- Лаборатория без DX станет шаманским алтарем для двух инженеров.
- Лаборатория с плохим viewer будет игнорироваться.
- CI без flakiness taxonomy будет либо блокировать всех, либо никто не будет ему верить.
- Retention без политики превратит artifact store в болото.
- Zero-claim снова полезет через формулировку `почти бесплатно`.
- DOM_C нельзя продавать как SwiftUI.
- DOM_C нельзя считать free только потому, что WebGL не платит.
- Future materials нельзя прикручивать копипастой.
- Vision Pro glass нельзя притворять расширением iPhone rig.
- v1.1 мерил стекло без flat null. pipeline noise и эффект оставались слитыми.
- v1.1 solver минимизировал diff без identifiability. degenerate-фит мог намайнить ложный match.
- v1.1 оставил gesture single-source неявным. два runner-формата могли разойтись.
- v1.1 shader threshold занимал слепые зоны WebKit через webkit_gap.
- v1.1 verdict enum слил parity level с disposition.
- v1.1 нигде не запретил layer-snapshot захват системного стекла.
- v1.1 оставил цветовое пространство perceptual metric неназванным.

## ИДЕАЛ

- Лаборатория остается станком.
- Станок режет по физике, цвету, восприятию, движению, стоимости и продуктовой читаемости.
- Technical truth отделен от product truth.
- Product truth не имеет права отменять technical fail.
- Product truth имеет право блокировать technical pass.
- Null self-test предшествует любому замеру паритета.
- Flat null доказывает эквивалентность фона до того, как любой glass-diff получает доверие.
- Recovered параметры несут identifiability-тег, никогда голый claim "matched".
- Рабочий фит не выбрасывается за неидентифицируемость. ограничивается только его claim.
- Native glass reference снимается на compositor level, никогда layer-snapshot'ом.
- Perceptual metric работает внутри залоченного цветового пространства, никогда его не отменяя.
- G7 становится structured Design & Legibility Sign-off Gate.
- G7 запускается только после technical pass.
- G7 не принимает фразу `не нравится`.
- G7 принимает только artifact-bound objection.
- G7 требует scene id.
- G7 требует state id.
- G7 требует mask id.
- G7 требует screenshot или frame sequence.
- G7 требует reviewer category.
- G7 требует owner decision.
- G7 может вернуть `PROD_PASS`.
- G7 может вернуть `PASS_WITH_REVIEW`.
- G7 может вернуть `BLOCKED_FOR_DESIGN`.
- G7 может вернуть `LEGIBILITY_BLOCK`.
- G7 не может вернуть `SWIFTUI_PASS` для DOM_C.
- G7 не может скрыть R1 vs R0 gap.
- G7 не может снизить metric threshold.
- G7 не может принять simulator artifact.
- Baseline должен иметь statistical spine.
- MVL uses `repeat_n = 50`.
- Production P99 uses `repeat_n >= 300`.
- `n = 50` reports `P95` and `P99_estimate`.
- `n = 50` cannot mint final P99 gate.
- `n >= 300` gives usable tail observation for P99-class gating.
- Bootstrap confidence interval хранится рядом с threshold.
- Threshold uses upper confidence bound.
- Outlier policy is versioned.
- Outlier removal never deletes raw artifact.
- Every rejected sample keeps rejection reason.
- Every baseline is keyed by device + OS build + SDK build + capture daemon version.
- Every baseline is immutable.
- New iOS build creates new baseline namespace.
- Old baseline remains auditable.
- Runtime truth includes sustained truth.
- G5 measures short-frame performance.
- G6 measures energy, thermal, and sustained degradation.
- G6 runs only on physical devices.
- G6 records thermal state transitions.
- G6 records sustained frame degradation.
- G6 records power trace when the runner supports it.
- G6 uses Instruments Power Profiler as primary lab path.
- G6 uses MetricKit as long-horizon production signal.
- G6 treats `powermetrics` as optional host-side auxiliary only after validation.
- DX is part of correctness.
- A metric nobody can inspect will be bypassed.
- A heatmap nobody can drill into will be dismissed.
- Artifact viewer becomes first-class product.
- Replay mode is allowed for iteration.
- Replay mode is marked `INVALID`.
- Simulator mode is allowed for DX and smoke.
- Simulator mode is marked `INVALID`.
- CI is not a suggestion engine.
- CI is a glass guillotine.
- PR regression gets auto-blocked.
- PR block includes exact failing gate.
- PR block includes artifact hashes.
- PR block includes heatmap.
- PR block includes temporal phase plot.
- PR block includes runtime and energy tables.
- Flakiness classification prevents false blame.
- Trend reporting catches slow rot.
- Retention policy keeps storage finite and audits possible.
- Zero-claim policy is strengthened.
- `WebGL incremental cost = 0` is allowed only as narrow field.
- `full frame cost = 0` is forbidden.
- `DOM_C = SwiftUI` is forbidden.
- `DOM_C` can only receive `WEBKIT_PASS`, `PASS_WITH_REVIEW`, `BLOCKED_FOR_DESIGN`, `FAIL`, or `INVALID`.
- Core lab becomes material-agnostic.
- Glass is first material, not the only material.
- Spatial glass becomes separate rig family.

## МОДЕЛЬ

### Scene Matrix

- S00 = null passthrough. test-card only. no glass. candidate renders identity.
- S01 = search/input capsule с выделением текста.
- S02 = loupe/bubble при drag по тексту.
- S03 = press state у glass button/control.
- S04 = morph между двумя glass-формами.
- S05 = floating bottom/tab/search bar над контентом.
- S06 = tiny glass control.
- S07 = glass over busy photo.
- S08 = glass over saturated P3 gradient.
- S09 = glass over near-white content.
- S10 = glass over near-black content.
- S11 = glass over video-like high-frequency frame.
- S12 = glass mixed with system material adjacency.
- S00 is qualification fixture, not parity-scored.
- S01-S05 are parity core.
- S06-S12 are G7 stress scenes.
- S07-S11 backgrounds are also degeneracy-breaking fuel for the solver loss.
- Every scene has fixed background pack.
- Every scene has fixed geometry pack.
- Every scene has fixed gesture script.
- Every scene has fixed capture timeline.
- Every scene has mask pack.
- Mask `core` measures body glass.
- Mask `edge_band` measures lens edge.
- Mask `highlight` measures specular placement.
- Mask `text` protects legibility.
- Mask `text_halo` protects glyph edge clarity.
- Mask `background_control` catches false positives in background.
- Mask `motion_path` measures temporal phase.
- Mask `compositor_region` isolates DOM/WebKit layer cost.
- Mask `product_focus` marks real UI hierarchy priority.
- S00 background pack = null-ladder: flat P3 grey, full ramp incl. out-of-sRGB, hard edge, smooth gradient.
- Procedural scenes (gradient, noise, ramp) are keyed by `content_seed`.
- Asset scenes (busy photo, video frame) are keyed by `background_asset_hash`.
- Every scene records whichever key applies. both fields may be present.

### Gesture Authority

- One trajectory definition exists per gesture scene.
- Trajectory is a sample list: `{x, y, t, phase, pressure}`.
- Native R0 gesture and candidate gesture compile from the same trajectory source.
- XCUITest and WebDriver/Pointer are consumers of the trajectory, never authors.
- Two independently authored scripts are forbidden.
- A divergent trajectory measures gesture difference, not glass difference.
- Gesture fixture stores the trajectory source, then per-runner compiled targets.
- Temporal gate is valid only when both rigs replay a byte-identical source trajectory.
- Delivered events are not byte-identical across input stacks. only the source is.
- XCUITest timing is not frame-locked. acceptable for MVL.
- 120Hz loupe and drag may need lower-level injection. flagged, not solved.

### Pipeline Qualification (Null Ladder)

- Pipeline qualification runs before the gate stack is trusted.
- Pipeline qualification runs when color pipeline, WebKit bridge, or WebGL path changes.
- Null Ladder renders each candidate path in passthrough over S00.
- Null Ladder runs C0 passthrough and DOM_C passthrough independently.
- Each candidate color path is qualified on its own. WebGL drawing buffer and WKWebView CSS compositing are separate paths.
- Null Ladder diffs passthrough output against native test-card capture.
- Flat-grey and hard-edge rungs require byte-equality.
- Gradient rung allows dither divergence: structural-flat after Noise Separator removes matched-amplitude dither.
- Ramp rung exercises out-of-sRGB primaries to catch gamut path errors.
- Ladder climbs in order. first non-flat rung names the broken layer.
- A non-flat null disqualifies the pipeline. every downstream metric is pipeline noise plus effect, fused.
- Pipeline qualification status is recorded in the baseline namespace.

### Rig Taxonomy

- R0 = Native Reference Rig.
- R0 uses SwiftUI glass APIs and UIKit system controls.
- R0 forbids manual styling.
- R0 is SwiftUI/UIKit truth.
- R1 = WebKit Reference Rig.
- R1 uses WKWebView DOM/CSS overlay.
- R1 uses `backdrop-filter` and `-webkit-backdrop-filter` where required.
- R1 is WebKit truth.
- R1 is not SwiftUI truth.
- C0 = Candidate Calibration Rig.
- C0 uses Babylon/WebGL shader.
- C0 injects solver parameters as uniforms.
- C0 can run headless for broad solver sweep.
- C0 supports passthrough mode for null qualification.
- C0 cannot issue verdict.
- C1 = Candidate Verdict Rig.
- C1 bakes selected Pareto parameters into shader source.
- C1 uses hardcoded constants and `#define`.
- C1 runs final capture only on physical iPhone.
- DOM_C = Candidate DOM Rig.
- DOM_C uses DOM/CSS overlay above Babylon canvas.
- DOM_C is selected first for app chrome.
- DOM_C is rejected for glass inside the 3D scene.
- DOM_C supports passthrough mode for null qualification.
- DX_REPLAY = local replay rig.
- DX_REPLAY loads artifacts and candidate params.
- DX_REPLAY is for iteration only.
- DX_REPLAY verdict is always invalid.

### Verdict Classes

- Verdict taxonomy has two axes: technical parity level and final disposition.
- TechnicalClass = parity level.
- `SWIFTUI_PASS` = R0-level native parity.
- `WEBKIT_PASS` = R1-level WebKit parity.
- `SHADER_PASS` = C1-level shader parity against R0 tolerance.
- `FAIL` (technical) = a hard technical gate failed.
- `INVALID` (technical) = artifact, device, color, rig, or capture-path is illegal.
- VerdictClass = final disposition.
- `TECH_PASS_PENDING_SIGNOFF` = G0-G6 passed, G7 not completed.
- `PASS_WITH_REVIEW` = G0-G6 passed, G7 found non-blocking product concern.
- `PROD_PASS` = G0-G7 passed.
- `BLOCKED_FOR_DESIGN` = technical pass blocked by product/design evidence.
- `LEGIBILITY_BLOCK` = technical pass blocked by text readability evidence.
- `FAIL` (disposition) = pipeline terminated on hard gate failure.
- `INVALID` (disposition) = illegal path, no verdict possible.
- Final disposition never carries a parity-level token.
- Every report shows both axes.
- `INVALID` and `INVALID_FOR_VERDICT` are the same terminal state.
- Replay and simulator outputs use `INVALID` with reason `NON_PHYSICAL_PATH`. no parallel token.

### Gate Stack

- G0 = Artifact Integrity Gate.
- G0 validates schema.
- G0 validates hashes.
- G0 validates mask pack.
- G0 validates PNG sequence.
- G0 validates embedded ICC profile.
- G0 fails hard on missing Display P3 ICC.
- G0 fails hard on missing device identity.
- G0 fails hard on simulator verdict attempt.
- G0 fails hard on layer-snapshot glass capture.
- G1 = Color Management Gate.
- G1 decodes PNG with ICC awareness.
- G1 forbids silent sRGB conversion.
- G1 normalizes R and C to linear Display P3.
- G1 computes OKLab comparison buffers.
- G1 rejects shader tint compensation for profile mismatch.
- G1 runs a flat-grey null sentinel per capture as a cheap pipeline tripwire.
- G1 null sentinel fails hard on non-flat residual beyond quantization + dither floor.
- G1 trusts a green pipeline qualification for the full ladder; the sentinel only guards drift.
- G2 = Static Perception Gate.
- G2 uses FLIP-style perceptual error.
- G2 runs the perceptual metric inside the locked linear Display P3 working space.
- G2 configures perceptual metric internal color transforms for P3, never assumed sRGB.
- G2 uses MS-SSIM/SSIM on masks.
- G2 uses OKLab ΔE for tint and opacity.
- G2 uses gradient smoothness score.
- G2 uses pixel diff only as debug heatmap.
- G3 = Glass Optics Gate.
- G3 measures edge lensing vector field.
- G3 estimates blur radius by frequency falloff.
- G3 measures chromatic fringe at edge band.
- G3 measures highlight position, width, and intensity.
- G3 highlight metric tolerates SDR clip or requires an EDR-preserving capture.
- G3 measures inner shadow falloff.
- G3 measures alpha/tint separation.
- G4 = Temporal Gate.
- G4 measures optical-flow phase error.
- G4 measures press overshoot.
- G4 measures damping.
- G4 measures settle time.
- G4 measures frame pacing.
- G4 fails on green static frames with broken motion.
- G4 is valid only on a byte-identical source trajectory across both rigs.
- G5 = Runtime & Compositor Gate.
- G5 runs only on physical device.
- G5 measures baked shader for C1.
- G5 measures compositor cost for DOM_C.
- G5 measures full-frame cost for every candidate.
- G5 reports WebGL incremental cost as a sub-field only.
- G5 fails if glass pushes p95 frame cost beyond threshold.
- G5 fails on dropped frames inside capture window.
- G6 = Energy & Sustained Performance Gate.
- G6 runs 10-second short stress.
- G6 runs 60-second sustained stress.
- G6 records initial thermal state.
- G6 records final thermal state.
- G6 records thermal transition timeline.
- G6 records sustained FPS degradation.
- G6 records sustained p95 frame interval.
- G6 records energy trace when available.
- G6 requires thermal_state_start = nominal before a sustained run.
- G6 fails on serious thermal onset inside sustained window.
- G6 fails on critical thermal state.
- G6 fails on sustained degradation above threshold.
- G7 = Design & Legibility Sign-off Gate.
- G7 runs only after G0-G6 pass.
- G7 reviews core scenes.
- G7 reviews stress scenes.
- G7 requires design reviewer.
- G7 requires product reviewer.
- G7 requires explicit category for every block.
- G7 cannot pass a failed technical gate.
- G7 can block a technical pass.
- G8 = Final Verdict Gate.
- G8 accepts only physical-device artifacts.
- G8 accepts only baked C1 for shader verdict.
- G8 accepts DOM_C only as WebKit verdict.
- G8 accepts only compositor-level glass reference captures.
- G8 emits final class.

### Metric Stack

- Primary visual metric = FLIP-style perceptual error.
- Perceptual metric runs inside the locked linear Display P3 working space.
- Perceptual metric internal color transforms are configured for P3, never assumed sRGB.
- A perceptual metric that re-converts color silently voids G1.
- Structural metric = MS-SSIM/SSIM.
- Color metric = OKLab ΔE.
- Gradient metric = banding score after low-frequency isolation.
- Noise metric = high-frequency residual after structure removal.
- Dither tolerance = uncorrelated high-frequency noise below learned amplitude.
- Dither penalty = structured noise or visible gradient damage.
- Edge metric = lensing displacement vector error.
- Blur metric = local MTF/frequency falloff mismatch.
- Fringe metric = edge-channel separation mismatch.
- Highlight metric = centroid + width + intensity mismatch, SDR-clip aware.
- Text metric = glyph edge contrast over glass.
- Text halo metric = local contrast stability around glyph mask.
- Motion metric = phase + overshoot + damping + settle mismatch.
- Runtime metric = p95 frame cost and dropped-frame count.
- Energy metric = power trace summary or MetricKit-derived trend.
- Thermal metric = time to serious and time to critical.
- Sustained metric = frame degradation slope over 60 seconds.
- Identifiability metric = per-parameter status tag from the multi-background fit.
- Verdict metric = hard-gated weighted loss.

### Baseline Math

```txt
repeat_n_mvl = 50
repeat_n_prod_p99 = 300
repeat_n_sustained = 24
instrument_noise_p95(scene,state,metric) = P95(metric(R0_i, R0_j)) over repeated physical captures
instrument_noise_p99_estimate(scene,state,metric) = P99_estimate(metric(R0_i, R0_j)) over repeat_n_mvl
instrument_noise_p99(scene,state,metric) = P99(metric(R0_i, R0_j)) over repeat_n_prod_p99
instrument_noise_ci95_upper(scene,state,metric) = bootstrap_upper_bound(metric(R0_i, R0_j), q=0.99, confidence=0.95)
webkit_gap(scene,state,metric) = metric(R0, R1) after color normalization
candidate_loss(scene,state,metric) = metric(R0, C1) or metric(R1, DOM_C)
difficulty(scene,state) = local_frequency_energy(R0)            # optional scene-difficulty term, derived from R0 only
shader_threshold = instrument_noise_ci95_upper + SHADER_SLACK(metric)
webkit_threshold = instrument_noise_ci95_upper + WEBKIT_SLACK * metric(R1_i, R1_j)
no_worse_than_webkit = candidate_loss(R0,C1) <= webkit_gap      # report-only floor, not a gate
PASS requires candidate_loss <= threshold for every hard metric
```

- `repeat_n_mvl = 50` is allowed for Day 1 and Week 1.
- `repeat_n_mvl = 50` cannot produce final P99 verdict.
- `repeat_n_prod_p99 = 300` is required for production P99-class thresholds.
- `repeat_n_prod_p99 = 300` applies to fast per-frame metrics: static, optics, short runtime.
- `repeat_n_sustained` applies to sustained and energy baselines, because each run is 60 seconds.
- Bootstrap CI is mandatory for production baselines.
- Threshold uses the upper bound, not the optimistic mean.
- SHADER_SLACK and WEBKIT_SLACK are named per-metric policy constants.
- Each slack constant has an owner and a one-line derivation in the baseline file.
- An unowned magic multiplier is forbidden, same rule as zero-claim.
- shader_threshold never borrows webkit_gap. C1 is scored against R0; webkit_gap carries WebKit's own blind spots.
- shader_threshold loosened by webkit_gap would give the shader the most slack exactly where WebKit is worst.
- webkit_gap survives only as no_worse_than_webkit, a report-only floor.
- Optional scene-difficulty scaling derives from R0 content statistics, never from R1.
- Baseline capture precondition: thermal_state_start = nominal.
- Cooldown to nominal between sustained runs is enforced and logged.
- A capture that starts non-nominal is rejected, reason DEVICE_STATE_DRIFT.
- Baseline namespace includes device model.
- Baseline namespace includes model identifier.
- Baseline namespace includes iOS version.
- Baseline namespace includes iOS build.
- Baseline namespace includes SDK build.
- Baseline namespace includes capture daemon version.
- Baseline namespace includes renderer dependency lockfile hash.
- Baseline namespace includes WebKit build when observable.
- Baseline namespace includes pipeline qualification status.
- R0 self-noise defines instrument floor.
- R1 vs R0 defines WebKit platform gap.
- DOM_C vs R1 is pass path.
- DOM_C vs R0 is report-only truth.
- C1 vs R0 is shader pass path.

### Outlier Policy

- Outlier detection uses IQR and modified z-score.
- Outlier rejection requires artifact evidence.
- Outlier rejection requires reason code.
- `THERMAL_SPIKE` = thermal transition during capture.
- `BACKGROUND_PROCESS` = OS/app activity outside test path.
- `COMPOSITOR_GLITCH` = isolated frame anomaly with stable pre/post frames.
- `CAPTURE_DAEMON_ERROR` = missing timestamp, partial frame, or broken hash.
- `CAPTURE_PATH_INVALID` = glass captured by layer snapshot instead of compositor path.
- `DEVICE_STATE_DRIFT` = brightness, power mode, accessibility, refresh, or non-nominal thermal start mismatch.
- `UNKNOWN_OUTLIER` cannot be deleted from baseline.
- Rejected samples remain in artifact store.
- Rejected samples are excluded from threshold only with signed reason.
- Outlier rate above threshold fails infrastructure health.

### Device Policy

- `simulator_allowed = smoke | solver_sweep | schema_test | dx_replay`.
- `simulator_forbidden = capture_reference | verdict_gate | perf_gate | energy_gate | thermal_gate`.
- `physical_required = R0 | R1 | C1 | DOM_C verdict`.
- System glass reference capture path is part of artifact validity.
- Layer-snapshot glass capture is INVALID, never a verdict source.
- Minimum production matrix = weakest supported iPhone + target iPhone + latest Pro iPhone.
- MVL matrix = one physical iPhone locked to target iOS build.
- Device state is part of artifact identity.
- OS build is part of artifact identity.
- Screen scale is part of artifact identity.
- Refresh rate is part of artifact identity.
- Thermal state is part of artifact identity.
- Power mode is part of artifact identity.
- Accessibility toggles are part of artifact identity.
- Appearance mode is part of artifact identity.
- Reduce Transparency is pinned.
- Reduce Motion is pinned.
- True Tone is disabled for physical display recordings.
- Night Shift is disabled for physical display recordings.
- Brightness setting is recorded even when screenshot path is software-composited.

### CaptureArtifact Contract

```ts
export type RigId = 'R0' | 'R1' | 'C0' | 'C1' | 'DOM_C' | 'DX_REPLAY';
export type SceneId =
  | 'S00_NULL'
  | 'S01_SEARCH'
  | 'S02_LOUPE'
  | 'S03_PRESS'
  | 'S04_MORPH'
  | 'S05_FLOATING_BAR'
  | 'S06_TINY_GLASS'
  | 'S07_BUSY_PHOTO'
  | 'S08_P3_GRADIENT'
  | 'S09_NEAR_WHITE'
  | 'S10_NEAR_BLACK'
  | 'S11_VIDEO_FRAME'
  | 'S12_SYSTEM_MATERIAL_ADJACENCY';

export type TouchPhase = 'rest' | 'press' | 'drag' | 'release' | 'morph' | 'sustained';

export type TechnicalClass =
  | 'SWIFTUI_PASS'
  | 'WEBKIT_PASS'
  | 'SHADER_PASS'
  | 'FAIL'
  | 'INVALID';

export type VerdictClass =
  | 'TECH_PASS_PENDING_SIGNOFF'
  | 'PASS_WITH_REVIEW'
  | 'PROD_PASS'
  | 'BLOCKED_FOR_DESIGN'
  | 'LEGIBILITY_BLOCK'
  | 'FAIL'
  | 'INVALID';

export type FlakeClass =
  | 'NONE'
  | 'INFRA_FLAKE'
  | 'PRODUCT_REGRESSION'
  | 'METRIC_NOISE'
  | 'UNKNOWN';

export type IdentifiabilityTag =
  | 'MEASURED'
  | 'BOUNDED_AMBIGUOUS'
  | 'PROBABLE_UNDER_PRIOR'
  | 'AMBIGUOUS';

export type CaptureKind = 'compositor' | 'framebuffer' | 'layer_snapshot';

export interface CaptureArtifact {
  schema_version: '1.2.0';
  id: string;
  rig_id: RigId;
  scene_id: SceneId;
  state_id: string;
  git_commit: string;
  technical_class?: TechnicalClass;
  null_qualification?: 'pass' | 'fail';
  capture_kind: CaptureKind;       // glass reference must be 'compositor' or 'framebuffer'
  device_info: {
    model_name: string;
    model_identifier: string;
    os_name: 'iOS';
    os_version: string;
    os_build: string;
    sdk_build: string;
    screen_scale: number;
    refresh_hz: number;
    thermal_state_start: 'nominal' | 'fair' | 'serious' | 'critical';
    thermal_state_end?: 'nominal' | 'fair' | 'serious' | 'critical';
    low_power_mode: boolean;
  };
  environment: {
    appearance: 'light' | 'dark';
    reduce_transparency: boolean;
    reduce_motion: boolean;
    content_seed?: string;             // procedural scenes
    background_asset_hash?: string;    // asset scenes
    viewport_px: { width: number; height: number };
    capture_timestamp_ns: string;
  };
  color: {
    embedded_icc_profile: 'Display P3';
    icc_sha256: string;
    working_space: 'display-p3-linear';
    stored_transfer: 'srgb-transfer';  // iOS screenshot is sRGB-transfer-encoded P3; 'linear' is not a valid stored value
    white_point: 'D65';
  };
  frame_pack: {
    base_png_sha256: string;
    base_png_path: string;
    sequence_paths?: string[];
    mask_pack_sha256: string;
    mask_pack_path: string;
    touch_phase: TouchPhase;
    animation_t: number;
    sustained_duration_ms?: number;
    trajectory_source_sha256?: string; // single source for both rigs
  };
  shader?: {
    pipeline: 'uniform_calibration' | 'baked_verdict' | 'dom_css' | 'dx_replay' | 'passthrough';
    param_hash?: string;
    baked_shader_hash?: string;
    replay_source_artifact_id?: string;
    identifiability?: Record<string, IdentifiabilityTag>;
  };
  perf?: {
    cpu_frame_ms_p95?: number;
    gpu_frame_ms_p95?: number;
    compositor_frame_ms_p95?: number;
    full_frame_ms_p95?: number;
    frame_interval_ms_p95?: number;
    dropped_frames?: number;
    sustained_degradation_pct?: number;
    memory_mb_p95?: number;
  };
  energy?: {
    trace_available: boolean;
    trace_tool?: 'instruments_power_profiler' | 'metrickit' | 'validated_powermetrics_aux';
    energy_mj_per_10s?: number;
    average_power_mw?: number;
    thermal_onset_ms?: number;
  };
  review?: {
    g7_status?: 'not_run' | 'passed' | 'pass_with_review' | 'blocked_for_design' | 'legibility_block';
    design_reviewer?: string;
    product_reviewer?: string;
    comments_sha256?: string;
  };
  integrity: {
    artifact_sha256: string;
    producer_version: string;
  };
}
```

### Solver Model

- Solver is black-box by default.
- CMA-ES is default optimizer.
- TPE/Optuna is allowed for coarse mixed spaces.
- Gradient descent is allowed only for differentiable isolated probes.
- Loss function consumes G2/G3/G4 metrics.
- Loss is summed across the degeneracy-breaking background sweep, not a single background.
- The degeneracy-breaking backgrounds (S07–S11 content) are available to the solver loss, not held back to G7.
- Perf penalty is added during late-stage ranking.
- Energy penalty is added only after physical replay data exists.
- Solver search runs mostly in headless/browser mode.
- Solver promotes Pareto-front candidates.
- Promoted candidates are baked.
- Baked candidates are replayed on physical device.
- Physical replay is mandatory before verdict.
- Human does not tune blur by hand.
- Human defines probes, masks, constraints, scenes, and acceptance classes.

### Identifiability Model

- Solver recovers a parameter vector. The vector is not automatically identifiable.
- blur radius and opacity are observationally degenerate.
- refractive strength and edge lensing are observationally degenerate.
- inner shadow and tint are weakly degenerate, broken by spatial profile on a flat field, confusable on texture.
- A single-background fit mints a degenerate minimum.
- Multi-background loss breaks most degeneracies. some survive.
- Every recovered parameter carries an identifiability tag: MEASURED, BOUNDED_AMBIGUOUS, PROBABLE_UNDER_PRIOR, or AMBIGUOUS.
- An AMBIGUOUS parameter cannot back "matched Apple's value".
- An AMBIGUOUS parameter can back "matching output on tested backgrounds".
- A working fit is never discarded for ambiguity. only its claim is constrained.
- Identifiability tags ride next to parameters in every report, like Ring-Φ.

### Shader Pipeline

- Calibration Mode uses uniforms.
- Calibration Mode avoids recompilation per mutation.
- Calibration Mode optimizes search throughput.
- Calibration Mode cannot produce runtime verdict.
- Passthrough Mode renders identity for null qualification.
- Passthrough Mode cannot produce parity verdict.
- Verdict Mode bakes parameters into shader source.
- Verdict Mode compiles selected Pareto candidates once.
- Verdict Mode measures real frame cost.
- Verdict Mode measures real thermal behavior.
- Verdict Mode is the only shader mode eligible for `SHADER_PASS`.
- Any runtime claim from Calibration Mode is invalid.
- Any energy claim from Calibration Mode is invalid.

### Platform Routing

- Native iOS app routes glass UI to SwiftUI/UIKit first.
- Telegram Mini App routes app chrome to DOM_C first.
- Telegram Mini App routes real text input and selection to DOM where possible.
- Canvas text selection is rejected unless product requires it.
- Babylon/WebGL is reserved for canvas-bound optics.
- DOM overlay must not be occluded by canvas depth.
- DOM overlay must be captured with same background pack as canvas.
- DOM overlay reports compositor cost separately from WebGL cost.
- DOM overlay reports full-frame cost always.
- Claim `WebGL incremental cost = 0` is allowed only as narrow metric.
- Claim `total GPU cost = 0` is forbidden.
- Claim `full frame cost = 0` is forbidden.
- Claim `SwiftUI diff = 0` is forbidden until R0 comparison proves it.
- DOM_C can never receive `SWIFTUI_PASS`.
- DOM_C can receive `WEBKIT_PASS`.
- DOM_C can receive `PASS_WITH_REVIEW`.
- DOM_C can receive `BLOCKED_FOR_DESIGN`.
- DOM_C can receive `FAIL`.
- DOM_C can receive `INVALID`.

### DX Surface

- DX is a first-class subsystem.
- DX owns artifact inspection.
- DX owns local replay.
- DX owns report navigation.
- DX owns developer trust.
- Artifact Diff Viewer shows R0 vs R1 vs C1 vs DOM_C.
- Artifact Diff Viewer shows masks.
- Artifact Diff Viewer shows heatmap.
- Artifact Diff Viewer shows optical vector field.
- Artifact Diff Viewer shows gradient banding map.
- Artifact Diff Viewer shows temporal phase plot.
- Artifact Diff Viewer shows frame budget timeline.
- Artifact Diff Viewer shows energy trace summary when available.
- Artifact Diff Viewer shows null qualification status and per-parameter identifiability tags.
- Artifact Diff Viewer supports drilldown by scene, state, mask, metric, device, OS build.
- Replay Mode loads CaptureArtifact.
- Replay Mode loads baked shader params.
- Replay Mode runs without physical device.
- Replay Mode accelerates shader iteration.
- Replay Mode marks every output `INVALID`, reason `NON_PHYSICAL_PATH`.
- Simulator Mode marks every output `INVALID`, reason `NON_PHYSICAL_PATH`.
- `glass lab inspect <artifact-id>` opens artifact summary.
- `glass lab diff <r-artifact> <c-artifact>` opens viewer.
- `glass lab replay <artifact-id> --candidate <param-hash>` starts replay.
- `glass lab instruments <artifact-id>` opens matching trace when available.
- `glass lab explain <verdict-id>` prints gate-local failure chain.
- `glass lab null <rig>` runs the Null Ladder for a candidate path.

### CI/CD Glass Gate

- Glass Gate triggers on renderer code changes.
- Glass Gate triggers on shader changes.
- Glass Gate triggers on CSS changes.
- Glass Gate triggers on UI geometry changes.
- Glass Gate triggers on animation curve changes.
- Glass Gate triggers on typography changes.
- Glass Gate triggers on background asset changes.
- Glass Gate triggers on color pipeline changes.
- Glass Gate triggers on Babylon/WebGL dependency changes.
- Glass Gate triggers on WebKit bridge changes.
- Glass Gate runs Null Ladder when color pipeline, WebKit bridge, or WebGL path changes.
- A PR with a failing null qualification is blocked before parity is scored.
- Fast PR lane runs selected states on primary physical device.
- Full nightly lane runs full scene matrix on device matrix.
- Sustained nightly lane runs G6 stress scenes.
- Solver lane runs separately and proposes candidates.
- PR lane never runs solver to hide regression.
- PR lane blocks on hard gate failure.
- PR lane blocks on repeated infrastructure flake.
- PR lane attaches diff heatmap.
- PR lane attaches metric table.
- PR lane attaches temporal phase plot.
- PR lane attaches runtime budget table.
- PR lane attaches energy/thermal table when G6 is in scope.
- PR lane links exact artifacts by hash.
- No artifact hash means no verdict.

### Flakiness Classification

- `INFRA_FLAKE` = device, daemon, cable, runner, thermal precondition, or capture failure.
- `PRODUCT_REGRESSION` = deterministic metric failure after valid captures.
- `METRIC_NOISE` = delta within instrument noise confidence interval.
- `UNKNOWN` = insufficient evidence.
- `INFRA_FLAKE` reruns once in PR lane.
- Repeated `INFRA_FLAKE` blocks as infrastructure red.
- `PRODUCT_REGRESSION` blocks as product red.
- `METRIC_NOISE` does not block alone.
- Repeated `METRIC_NOISE` becomes trend warning.
- `UNKNOWN` blocks until classified.

### Trend Reporting

- Nightly report shows last 30 valid runs.
- Nightly report shows per-gate trend.
- Nightly report shows per-device trend.
- Nightly report shows per-iOS-build trend.
- Nightly report shows visual loss slope.
- Nightly report shows runtime cost slope.
- Nightly report shows energy cost slope.
- Nightly report shows flake rate slope.
- Slow degradation gets warning before hard fail.
- Threshold drift requires baseline owner approval.

### Retention Policy

- Raw PNG frames retained for 90 days.
- Raw frame sequences retained for 90 days.
- Normalized buffers retained for 1 year.
- Metric JSON retained for 1 year.
- Verdict reports retained for 1 year.
- Power traces retained for 180 days.
- Baselines retained indefinitely.
- G7 review artifacts retained with verdict report.
- Failed PR artifacts retained for 1 year.
- Release-candidate artifacts retained indefinitely.
- Artifact hashes are immutable.
- Deletion never removes hash manifest.

### Generalization Roadmap

- Core lab must become material-agnostic.
- Glass implements `MaterialProbe`.
- Future material implements the same artifact contract.
- `MaterialProbe` owns masks.
- `MaterialProbe` owns metrics.
- `MaterialProbe` owns gates.
- `MaterialProbe` owns scene matrix.
- `MaterialProbe` owns its null-ladder fixture.
- Candidate materials can include liquid, metal, cloth, shadow, glow, depth haze.
- Core stays capture, color, null, artifact, metrics, solver, CI, viewer.
- Material pack changes only probes and thresholds.
- iOS version regression hunting runs nightly on device matrix.
- Regression hunting compares current OS build against archived baselines.
- Regression hunting never reuses baseline across OS build without explicit migration.
- Vision Pro gets separate rig family.
- Spatial glass gets depth-aware capture.
- Spatial glass gets stereo metrics.
- Spatial glass gets head-pose temporal metrics.
- Vision Pro work does not contaminate iPhone thresholds.

## РЕАЛИЗАЦИЯ

### Repository Layout

```txt
/apps/reference-ios              # SwiftUI/UIKit R0 + WKWebView R1 + compositor capture daemon
/apps/candidate-web              # Babylon/WebGL C0/C1 + DOM_C overlay + passthrough mode
/apps/artifact-viewer            # local diff viewer + replay UI
/packages/capture-schema         # TypeScript schema + JSON schema + validators
/packages/color-pipeline         # ICC decode, P3 linear normalization, OKLab conversion
/packages/null-ladder            # passthrough qualification + Noise Separator null check
/packages/metric-stack           # FLIP (P3-configured), SSIM/MS-SSIM, optics probes, temporal probes
/packages/energy-stack           # Instruments/MetricKit adapters + thermal parser
/packages/solver                 # CMA-ES/TPE runner + Pareto ranking + identifiability tagging
/packages/artifact-store         # immutable artifact writer + hash index
/packages/material-core          # MaterialProbe interface
/packages/material-glass         # glass probes, masks, thresholds, scenes
/ci/glass-gate.yml               # PR gate + nightly gate + null qualification
/fixtures/backgrounds            # locked content backgrounds + S00 null ladder
/fixtures/masks                  # scene masks
/fixtures/gestures               # single trajectory source; XCUITest + WebDriver are compiled consumers, not authors
/reports                         # generated markdown/html verdict reports
/baselines                       # immutable per-device per-build baselines
```

### Day 1 Bootstrap

- Create repository skeleton.
- Create `CaptureArtifact` TypeScript schema v1.2.
- Generate JSON Schema from TypeScript.
- Write strict validator.
- Add `exit(1)` on missing ICC profile.
- Add `exit(1)` on missing mask pack.
- Add `exit(1)` on missing device info.
- Add `exit(1)` on simulator verdict attempt.
- Add `exit(1)` on layer-snapshot glass capture.
- Add fixture background pack.
- Add S00 null-ladder fixture.
- Add fixture mask pack for S01 and S03.
- Build R0 native iOS screen for S01 search capsule.
- Build R0 native iOS screen for S03 glass button press.
- Wire compositor-level capture (ReplayKit/framebuffer) for R0 glass.
- Build R1 WKWebView screen for DOM glass overlay.
- Build C0 Babylon page with blank candidate slot.
- Build C0 passthrough mode.
- Run Null Ladder on C0 passthrough. require flat null before trusting any metric.
- Run Null Ladder on DOM_C passthrough independently.
- Author one trajectory source for S03 press. compile to XCUITest and Pointer targets from it.
- Add capture button for manual smoke.
- Add XCUITest script for rest/press/release compiled from the trajectory source.
- Export PNG + JSON + mask pack hash.
- Embed Display P3 ICC in exported PNG.
- Validate exported artifact with CLI.
- Normalize R0 and R1 through color pipeline.
- Capture `repeat_n_mvl = 50` for S01 rest on one physical iPhone.
- Capture `repeat_n_mvl = 50` for S03 press on one physical iPhone.
- Compute R0 self-noise P95.
- Compute R0 P99 estimate.
- Mark P99 estimate as non-production.
- Compute `webkit_gap = R1 - R0` for S01 and S03.
- Store baseline file by device + OS build.
- Implement initial FLIP-style metric adapter configured for linear Display P3.
- Implement SSIM/MS-SSIM adapter.
- Implement OKLab ΔE adapter.
- Implement pixel heatmap only for debug.
- Implement Edge Lensing Mapper prototype on S03 edge band.
- Implement Noise Separator prototype on S01 capsule gradient and S00 gradient rung.
- Implement first artifact viewer shell.
- Implement `glass lab inspect`.
- Implement `glass lab diff`.
- Implement `glass lab null`.
- Produce first `INVALID | FAIL | TECH_PASS_PENDING_SIGNOFF` report.

### Day 1 Commands

```bash
pnpm schema:build
pnpm artifact:validate ./artifacts/sample.capture.json
pnpm ios:build-reference
pnpm null:ladder --rig C0 --scene S00_NULL --device physical
pnpm null:ladder --rig DOM_C --scene S00_NULL --device physical
pnpm ios:capture --rig R0 --scene S01_SEARCH --state rest --device physical --capture compositor --repeat 50
pnpm ios:capture --rig R1 --scene S01_SEARCH --state rest --device physical --capture compositor --repeat 50
pnpm color:normalize ./artifacts/*.capture.json
pnpm metrics:baseline --ref R0 --probe R0 --repeat 50 --class mvl
pnpm metrics:webkit-gap --ref R0 --candidate R1
pnpm report:verdict --baseline ./baselines/current.json
pnpm glass:inspect <artifact-id>
pnpm glass:diff <r0-artifact-id> <r1-artifact-id>
```

### Week 1 Build Order

- Lock null qualification before trusting any parity number.
- Lock gesture trajectory source before adding temporal scenes.
- Lock schema before adding more scenes.
- Lock color pipeline before optimizing shader.
- Lock R0/R1 capture before solving parameters.
- Lock artifact viewer before onboarding more engineers.
- Add S02 loupe after S01 artifact pipeline is stable.
- Add S04 morph after temporal gate exists.
- Add S05 floating bar after DOM_C overlay exists.
- Add S06-S12 after G7 contract exists.
- Add C0 shader only after R0/R1 baseline exists.
- Add CMA-ES only after metrics are deterministic.
- Add identifiability tagging together with CMA-ES.
- Add C1 baked shader only after Pareto front exists.
- Add G6 short stress after G5 is stable.
- Add G6 sustained stress after trace adapter is stable.
- Add G7 reviewer workflow after report format is stable.
- Add CI physical gate only after local physical capture is reproducible.

### Production Baseline Build

- Run `repeat_n_prod_p99 = 300` for fast per-frame metrics on every core scene and state.
- Run `repeat_n_sustained` for sustained and energy baselines on every core scene and state.
- Run per device class.
- Run per iOS build namespace.
- Require thermal_state_start = nominal for every baseline capture.
- Enforce and log cooldown to nominal between sustained runs.
- Compute P99 and CI95 upper bound per metric.
- Store raw captures.
- Store normalized buffers.
- Store metric vectors.
- Store rejected outliers with reason.
- Store threshold derivation.
- Store pipeline qualification status.
- Require baseline owner approval.
- Freeze baseline by hash.

### Capture Daemon

- Capture Daemon lives inside native iOS test host.
- Capture Daemon exports artifacts, not screenshots alone.
- Capture Daemon captures system glass at compositor level: ReplayKit or framebuffer.
- Capture Daemon forbids layer snapshot for glass reference.
- drawHierarchy and UIGraphicsImageRenderer do not see the live glass backdrop.
- A layer-snapshot capture of R0 glass is rejected, reason CAPTURE_PATH_INVALID.
- Capture Daemon records device and OS build.
- Capture Daemon records SDK build.
- Capture Daemon records capture_kind.
- Capture Daemon records touch phase.
- Capture Daemon records animation timestamp.
- Capture Daemon records trajectory source hash.
- Capture Daemon records background hash.
- Capture Daemon records mask hash.
- Capture Daemon records thermal start and end.
- Capture Daemon records Low Power Mode.
- Capture Daemon embeds Display P3 ICC.
- Capture Daemon writes immutable SHA-256 manifest.
- Capture Daemon refuses simulator artifacts for R0/R1/C1/DOM_C verdict.

### Candidate Web Runtime

- WebGL context requests Display P3 drawing buffer when available.
- WebGL texture import uses Display P3 unpack where available.
- Candidate runtime fails color gate if browser lacks required color path.
- Candidate runtime fails pipeline qualification if its passthrough null is non-flat.
- Babylon engine creation is patched to preserve color settings.
- Calibration uniforms are generated from schema.
- Verdict constants are generated from selected Pareto candidate.
- Passthrough mode renders identity for the Null Ladder.
- DOM overlay uses CSS glass only for UI-layer surfaces.
- DOM overlay records compositor metrics separately from WebGL metrics.
- DOM overlay records full-frame cost always.

### Color Pipeline

- Decode PNG with ICC awareness.
- Reject untagged PNG.
- Reject unexpected sRGB artifact for P3 scenes.
- Convert all artifacts to linear Display P3 working buffers.
- Convert color comparisons to OKLab.
- Hand the perceptual metric linear Display P3 with its internal transforms configured for P3.
- Preserve original PNG for audit.
- Preserve normalized buffer hash for metrics.
- Never optimize shader saturation to compensate for wrong profile.

### Null Ladder

- Null Ladder renders candidate passthrough over S00.
- Null Ladder runs C0 passthrough and DOM_C passthrough independently.
- Flat-grey rung requires byte-equality against native test-card capture.
- Hard-edge rung requires byte-equality.
- Ramp rung exercises out-of-sRGB primaries.
- Gradient rung requires structural-flat residual after Noise Separator removes matched-amplitude dither.
- Apple compositor dither is not byte-flat. only structure and amplitude must match.
- First non-flat rung names the broken layer.
- Null Ladder failure disqualifies the pipeline.
- Null Ladder status is stored in the baseline namespace.

### Optics Probes

- Edge Lensing Mapper uses edge-band mask.
- Edge Lensing Mapper estimates local displacement against background control.
- Edge Lensing Mapper outputs vector magnitude, direction, curl, and edge falloff.
- Blur Probe estimates local frequency attenuation.
- Fringe Probe measures chromatic separation near edge normal.
- Highlight Probe measures centroid drift and intensity mismatch.
- Highlight Probe accounts for SDR clipping. a bright specular may exceed SDR range and clip in screenshot capture.
- Where the highlight metric is load-bearing, capture preserves EDR or the threshold tolerates the clip explicitly.
- Noise Separator splits high-frequency dither from low-frequency gradient structure.
- Noise Separator ignores seed mismatch only when structure and amplitude match.
- Noise Separator penalizes banding even when pixel diff is numerically small.
- Text Probe measures glyph contrast over glass.
- Text Probe measures glyph edge preservation.
- Text Probe measures contrast stability across stress scenes.

### Energy Stack

- Energy Stack records short stress.
- Energy Stack records sustained stress.
- Energy Stack records thermal state timeline.
- Energy Stack records frame degradation slope.
- Energy Stack integrates Instruments Power Profiler traces when available.
- Energy Stack integrates MetricKit reports for long-horizon trend.
- Energy Stack does not require unsupported private sensors.
- Energy Stack marks unavailable power trace as `trace_unavailable`.
- `trace_unavailable` blocks release only when G6 policy requires energy trace.
- Thermal serious inside sustained window blocks.
- Thermal critical always blocks.

### Solver Loop

```txt
capture R0/R1 baseline
render C0 mutation in calibration mode over the degeneracy-breaking background sweep
normalize color
score G2/G3/G4 loss summed across the background sweep        # not a single background
label each parameter MEASURED | BOUNDED_AMBIGUOUS | PROBABLE_UNDER_PRIOR | AMBIGUOUS
update CMA-ES population
select Pareto front
constrain claims: AMBIGUOUS params may not back a parameter-level match claim
bake C1 candidates
replay C1 on physical device
score G2/G3/G4/G5/G6
route technical pass to G7
emit G8 verdict
```

- Solver cannot change color profile.
- Solver cannot change masks.
- Solver cannot change geometry.
- Solver cannot change background.
- Solver cannot change reviewer status.
- Solver cannot change identifiability tags.
- Solver can change refractive strength.
- Solver can change edge lensing.
- Solver can change blur kernel.
- Solver can change saturation lift.
- Solver can change inner shadow.
- Solver can change specular highlight.
- Solver can change chromatic aberration.
- Solver can change noise amplitude and spectral shape.
- Solver can change spring stiffness and damping.
- Solver can change morph curve.
- Solver output is Pareto front.
- A working fit is never discarded for ambiguity. only its claim is constrained.
- Verdict selects knee point under visual, runtime, energy, and design constraints.

### G7 Review Workflow

- G7 starts only after `TECH_PASS_PENDING_SIGNOFF`.
- G7 creates review packet.
- Review packet includes R0/R1/C1/DOM_C side-by-side.
- Review packet includes stress scenes.
- Review packet includes text masks.
- Review packet includes busy-background cases.
- Review packet includes motion clips.
- Review packet includes metrics summary.
- Review packet includes per-parameter identifiability tags.
- Design reviewer checks premium perception.
- Design reviewer checks material hierarchy.
- Design reviewer checks consistency with product surface.
- Product reviewer checks readability.
- Product reviewer checks interaction clarity.
- Product reviewer checks edge-case acceptability.
- Block requires category.
- Block requires artifact pointer.
- Block requires short written reason.
- Block creates actionable ticket.
- Non-blocking concern creates `PASS_WITH_REVIEW`.
- No naked taste verdict is allowed.

### Artifact Viewer

- Viewer opens by artifact id.
- Viewer shows exact commit.
- Viewer shows exact device.
- Viewer shows exact OS build.
- Viewer shows exact color profile.
- Viewer shows exact baseline namespace.
- Viewer shows null qualification status.
- Viewer shows R0/R1/C side-by-side.
- Viewer toggles masks.
- Viewer toggles heatmap.
- Viewer toggles vector field.
- Viewer toggles text contrast map.
- Viewer toggles per-parameter identifiability tags.
- Viewer scrubs frame sequence.
- Viewer overlays temporal phase.
- Viewer links Instruments trace.
- Viewer exports review packet.
- Viewer never marks replay output as verdict.

### CI Gate

```txt
PR touched render/UI/color/animation assets
classify lane
run Null Ladder if color/WebKit/WebGL path changed
block before parity scoring on null qualification fail
load locked baseline namespace
capture candidate on physical device at compositor level
run G0-G6
route technical pass to G7 only for release lane or protected surfaces
upload artifacts
classify flake or regression
block PR on hard fail
attach evidence
update trend dashboard
```

- Fast PR lane may skip G7 unless protected surface changes.
- Release lane always runs G7.
- Nightly lane always updates trend.
- Sustained lane runs at least once per night.
- Solver lane cannot auto-bless output.
- Baseline migration requires explicit approval.
- CI status names gate and class.
- CI comments are evidence-first.
- CI never says `looks off`.
- CI says `G3_EDGE_LENSING_FAIL` or equivalent.

### Verdict Report Format

```txt
VERDICT_CLASS: TECH_PASS_PENDING_SIGNOFF | PASS_WITH_REVIEW | PROD_PASS | BLOCKED_FOR_DESIGN | LEGIBILITY_BLOCK | FAIL | INVALID
TECHNICAL_CLASS: SWIFTUI_PASS | WEBKIT_PASS | SHADER_PASS | FAIL | INVALID
DESIGN_CLASS: NOT_RUN | PASS | PASS_WITH_REVIEW | BLOCKED_FOR_DESIGN | LEGIBILITY_BLOCK
FLAKE_CLASS: NONE | INFRA_FLAKE | PRODUCT_REGRESSION | METRIC_NOISE | UNKNOWN
NULL_QUALIFICATION: PASS | FAIL
DEVICE: model + identifier + iOS build
CAPTURE_KIND: compositor | framebuffer
SCENE: scene_id + state_id
COLOR: PASS | FAIL
STATIC: PASS | FAIL
OPTICS: PASS | FAIL
TEMPORAL: PASS | FAIL
RUNTIME: PASS | FAIL
ENERGY: PASS | FAIL | TRACE_UNAVAILABLE
DESIGN: PASS | REVIEW | BLOCK
IDENTIFIABILITY: per-parameter tag table
BASELINE: namespace + instrument_noise + webkit_gap + CI95 upper
LOSS: metric table
TREND: last 30 valid runs
ARTIFACTS: R0/R1/C1/DOM_C hashes
HEATMAPS: paths
TRACES: Instruments/MetricKit paths when available
BLOCKERS: exact failing gates
RETENTION: retention class
```

- Report starts with final verdict.
- Report shows both verdict axes, never collapses them.
- Report shows null qualification status.
- Report never hides R1 vs R0 gap.
- Report never reports DOM_C as SwiftUI parity.
- Report never reports calibration shader perf as production perf.
- Report never reports WebGL incremental cost as full cost.
- Report never uses naked pixel diff for pass.
- Report never claims a parameter is matched when its tag is AMBIGUOUS.
- Report always names invalid path when invalid.

## VERDICT

- Да, это зайдет.
- Принять надо почти всё.
- G7 принять обязательно.
- G7 не должен быть вкусом.
- G7 должен быть structured blocker.
- Statistical hardening принять обязательно.
- `n >= 50` поправить.
- `n >= 50` оставить только для MVL.
- Production P99 поднять до `n >= 300` плюс bootstrap CI.
- `n >= 300` ограничить fast per-frame метриками.
- Sustained baseline вынести в repeat_n_sustained.
- Outlier policy принять обязательно.
- Baseline versioning по iOS build принять обязательно.
- Energy gate принять обязательно.
- Sustained performance принять обязательно.
- `powermetrics` не делать основным iOS path без validation.
- Instruments Power Profiler сделать primary lab path.
- MetricKit сделать long-horizon signal.
- DX block принять обязательно.
- Artifact viewer сделать частью MVP, не украшением.
- Replay mode принять.
- Replay mode маркировать `INVALID`.
- Flakiness taxonomy принять обязательно.
- Trend report принять обязательно.
- Retention policy принять обязательно.
- Zero-claim policy усилить обязательно.
- DOM_C never gets `SWIFTUI_PASS`.
- DOM_C cost is full-frame cost.
- Generalization roadmap принять как post-MVL.
- iOS regression hunting принять как nightly target.
- Vision Pro вынести в отдельную rig-family.
- Null self-test принять обязательно. без него каждый замер слит с pipeline noise.
- Identifiability lattice вшить в solver обязательно. degenerate-фит не выбрасывать, его claim ограничивать.
- shader_threshold отвязать от webkit_gap обязательно.
- Verdict enum разнести на две оси обязательно.
- Compositor-level capture сделать единственным путём для glass reference.
- Perceptual metric держать в залоченном P3.
- v1.2 не добрее v1.1.
- v1.2 честнее к самой себе.
- v1.2 закрывает путь к самообману и со стороны метрик, и со стороны параметров.
- Финальная формула: `physical truth + null self-test + color lock + perceptual optics in-space + identifiability lattice + statistical baseline + black-box solver + baked verdict + sustained energy + structured design gate + CI guillotine + DX viewer + compositor-level capture`.
