import { clamp, distance } from './interaction.mjs';
import { normalizeTrackingTuning } from './tracking-tuning.mjs';

// Zones are in mirrored screen coordinates; a single face is never its own receiver.
export function resolveRoles(faces, { width = 1280, swapped = false, solo = false } = {}) {
  if (solo) return { caster: [...faces].sort((a, b) => a.x - b.x)[0] || null, receiver: null };
  const left = faces.filter(f => f.x < width * .5).sort((a, b) => a.x - b.x)[0] || null;
  const right = faces.filter(f => f.x > width * .5).sort((a, b) => b.x - a.x)[0] || null;
  return swapped ? { caster: right, receiver: left } : { caster: left, receiver: right };
}

const finitePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);
const MAX_SAMPLE_GAP = 650;
export const HELD_HAND_GRACE_MS = 1500;
const RELEASE_GRACE = 320;
const otherHandSnapshots = new WeakMap();
const handMotion = new WeakMap();

function rememberControlHand(hand, hands, previous = null, elapsed = 0) {
  if (hand) otherHandSnapshots.set(hand, hands.filter(other => other !== hand)
    .map(other => ({ wrist: { ...other.wrist }, label: other.label })));
  if (hand && previous && elapsed > 0) handMotion.set(hand, {
    x: (hand.wrist.x - previous.wrist.x) / elapsed,
    y: (hand.wrist.y - previous.wrist.y) / elapsed,
  });
  return hand;
}

export function handGrip(points, previous = false, gesture = null, worldPoints = null, options = {}) {
  if (points?.length !== 21 || !points.every(finitePoint)) return false;
  // World landmarks use the same metric on every axis, so a fist turned toward
  // the camera does not become an apparently straight finger in projection.
  const spatial = worldPoints?.length === 21 && worldPoints.every(point => finitePoint(point) && Number.isFinite(point.z));
  const shape = spatial ? worldPoints : points;
  const delta = (a, b) => [a.x - b.x, a.y - b.y, spatial ? a.z - b.z : 0];
  const length = vector => Math.hypot(...vector);
  const span = (a, b) => length(delta(a, b));
  const cosine = (a, b) => {
    const denominator = length(a) * length(b);
    return denominator > 1e-12 ? a.reduce((sum, value, index) => sum + value * b[index], 0) / denominator : 1;
  };
  // Across-palm width collapses for an edge-on hand. Wrist-to-knuckle length
  // supplies a second scale without depending on screen pixels or distance.
  const palm = Math.max(span(shape[5], shape[17]), span(shape[0], shape[9]) * .65,
    (span(shape[0], shape[5]) + span(shape[0], shape[17])) * .325);
  if (palm < 1e-6) return false;
  const pinchRatio = span(shape[4], shape[8]) / palm;
  // A deliberate pinch remains available even when the other three fingers
  // resemble an open palm. Confident classifications handle tilted fists and
  // open hands better than distances projected onto the camera image alone.
  if (pinchRatio < .46) return true;
  const validScore = Number.isFinite(gesture?.score) && gesture.score >= 0 && gesture.score <= 1;
  const confidence = Number.isFinite(options?.confidence) ? clamp(options.confidence, .5, .95) : .7;
  if (validScore && gesture.score >= confidence) {
    if (gesture.categoryName === 'Closed_Fist') return true;
    if (gesture.categoryName === 'Open_Palm') return false;
  }
  const pinched = pinchRatio < (previous ? .7 : .46);
  let folded = 0, extended = 0;
  for (const base of [5, 9, 13, 17]) {
    const knuckle = shape[base], pip = shape[base + 1], dip = shape[base + 2], tip = shape[base + 3];
    const segments = [delta(pip, knuckle), delta(dip, pip), delta(tip, dip)];
    const lengths = segments.map(length);
    const usable = lengths.every(value => value > palm * .03);
    const reach = usable ? span(tip, knuckle) / lengths.reduce((sum, value) => sum + value, 0) : 1;
    const bend = usable ? Math.min(cosine(segments[0], segments[1]), cosine(segments[1], segments[2])) : 1;
    const straight = usable && reach > .88 && bend > .7;
    if (straight) extended++;
    const towardWrist = span(tip, shape[0]) < span(pip, shape[0]) * (previous ? 1.2 : 1.08);
    const curled = usable && reach < (previous ? .86 : .8) && bend < .55;
    if (!straight && (towardWrist || curled)) folded++;
  }
  // A moderate classifier score needs geometric support. It can resolve two
  // visibly bent fingers; an open hand with a noisy label cannot start a grip.
  const possibleFist = validScore && gesture.categoryName === 'Closed_Fist' && gesture.score >= .45;
  return pinched || folded >= (previous || possibleFist ? 2 : 3)
    || (previous && possibleFist && gesture.score >= .55 && folded >= 1 && extended < 2);
}

export function handOpen(points, gesture = null, worldPoints = null, options = {}) {
  if (points?.length !== 21 || !points.every(finitePoint)) return false;
  const spatial = worldPoints?.length === 21 && worldPoints.every(point => finitePoint(point) && Number.isFinite(point.z));
  const shape = spatial ? worldPoints : points;
  const delta = (a, b) => [a.x - b.x, a.y - b.y, spatial ? a.z - b.z : 0];
  const length = vector => Math.hypot(...vector);
  const span = (a, b) => length(delta(a, b));
  const palm = Math.max(span(shape[5], shape[17]), span(shape[0], shape[9]) * .65,
    (span(shape[0], shape[5]) + span(shape[0], shape[17])) * .325);
  if (palm < 1e-6) return false;
  const confidence = Number.isFinite(options?.confidence) ? clamp(options.confidence, .5, .95) : .7;
  const validScore = Number.isFinite(gesture?.score) && gesture.score >= 0 && gesture.score <= 1;
  if (validScore && gesture.score >= confidence) {
    if (gesture.categoryName === 'Open_Palm') return true;
    if (['Closed_Fist', 'Pointing_Up', 'Thumb_Down', 'Thumb_Up', 'Victory', 'ILoveYou'].includes(gesture.categoryName)) return false;
  }
  // An unknown pose is not an open palm. Without a confident classifier,
  // require actual straight finger chains, with no thumb/index pinch.
  if (span(shape[4], shape[8]) / palm < .46) return false;
  let extended = 0;
  for (const base of [5, 9, 13, 17]) {
    const segments = [delta(shape[base + 1], shape[base]), delta(shape[base + 2], shape[base + 1]),
      delta(shape[base + 3], shape[base + 2])];
    const lengths = segments.map(length);
    if (!lengths.every(value => value > palm * .03)) continue;
    const reach = span(shape[base + 3], shape[base]) / lengths.reduce((sum, value) => sum + value, 0);
    const cosine = (a, b, magnitude) => a.reduce((sum, value, index) => sum + value * b[index], 0) / magnitude;
    const bend = Math.min(cosine(segments[0], segments[1], lengths[0] * lengths[1]),
      cosine(segments[1], segments[2], lengths[1] * lengths[2]));
    if (reach > .88 && bend > .7) extended++;
  }
  return extended >= 3;
}

export function chooseControlHand(hands, previous, { width = 1280, swapped = false, solo = false, elapsed = 80, anchor = null, preferGrip = false, gripOptions = null, fastMotion = false, recoverHeld = false } = {}) {
  const valid = hands.filter(hand => finitePoint(hand.palm) && finitePoint(hand.wrist));
  if (previous) {
    if (!finitePoint(previous.wrist) || !Number.isFinite(elapsed) || elapsed > (recoverHeld ? HELD_HAND_GRACE_MS : MAX_SAMPLE_GAP)) return null;
    const recovering = elapsed > MAX_SAMPLE_GAP;
    // A fast swing covers more pixels between sparse recognition results.
    // Keep the expansion bounded so a distant receiver's hand is not adopted.
    const reach = clamp(Math.max(0, elapsed) * 1.3, 190, 360);
    const direction = swapped ? -1 : 1, velocity = handMotion.get(previous);
    const forwardMotion = velocity && velocity.x * direction >= .2 && Math.abs(velocity.y) <= Math.abs(velocity.x);
    const others = otherHandSnapshots.get(previous) || [];
    // Left/Right labels identify hands, not people. Match all known hands
    // together so a visible peer is reserved for its own nearest track.
    const tracks = [previous, ...others], edges = [];
    for (const [trackIndex, track] of tracks.entries()) {
      for (const [handIndex, hand] of valid.entries()) {
        if (hand.label && track.label && hand.label !== track.label) continue;
        const moved = distance(hand.wrist, track.wrist);
        if (trackIndex === 0 && fastMotion && moved > 340 && !forwardMotion) continue;
        if (moved < (recovering && trackIndex === 0 ? Math.min(200, width * .18) : reach)) edges.push({ trackIndex, handIndex, moved });
      }
    }
    // After a longer absence, reserve known peers first. Reacquiring the old
    // wrist must not turn another participant into the person holding it.
    edges.sort((a, b) => (recovering ? Number(a.trackIndex === 0) - Number(b.trackIndex === 0) : 0)
      || a.moved - b.moved || b.trackIndex - a.trackIndex);
    const matched = new Map(), used = new Set();
    for (const edge of edges) {
      if (matched.has(edge.trackIndex) || used.has(edge.handIndex)) continue;
      matched.set(edge.trackIndex, valid[edge.handIndex]); used.add(edge.handIndex);
    }
    const selected = matched.get(0);
    if (selected) {
      if (!recovering) return rememberControlHand(selected, valid, previous, elapsed);
      const candidates = valid.filter((hand, index) => (hand === selected || !used.has(index))
        && !(hand.label && previous.label && hand.label !== previous.label)
        && distance(hand.wrist, previous.wrist) < Math.min(200, width * .18));
      if (candidates.length === 1) {
        // No velocity can be inferred across the invisible part of a swing.
        handMotion.delete(selected);
        return rememberControlHand(selected, valid);
      }
    }
    if (fastMotion && !recovering) {
      // A throw can cross several hundred pixels between camera results.
      // Reserve the normal matches above first, especially known peers, then
      // allow a bounded forward swing from the hand already holding a pumpkin.
      const fastReach = Math.min(width * .44, clamp(Math.max(0, elapsed) * 4 + 240, 340, 560));
      const predictable = velocity && velocity.x * direction > .4;
      const predicted = predictable ? { x: previous.wrist.x + velocity.x * elapsed,
        y: previous.wrist.y + velocity.y * elapsed } : previous.wrist;
      const candidates = valid.filter((hand, index) => {
        if (used.has(index) || (hand.label && previous.label && hand.label !== previous.label)) return false;
        const dx = hand.wrist.x - previous.wrist.x, dy = hand.wrist.y - previous.wrist.y;
        const moved = distance(hand.wrist, previous.wrist);
        // A single distant observation after a stationary hold may belong to
        // a newly visible receiver. The widest reach needs an existing swing.
        return moved < fastReach && (moved <= 340 || forwardMotion)
          && dx * direction > 0 && Math.abs(dy) <= Math.abs(dx) * .9 + 50;
      }).map(hand => ({ hand, error: distance(hand.wrist, predicted) }))
        .sort((a, b) => a.error - b.error);
      // Without motion evidence, competing distant hands are ambiguous. A
      // prediction can disambiguate them only when one is clearly closer.
      const fast = candidates.length === 1 ? candidates[0]
        : predictable && candidates[0]?.error < reach && candidates[1].error - candidates[0].error > 90 ? candidates[0] : null;
      if (fast) return rememberControlHand(fast.hand, valid, previous, elapsed);
    }
    // A held hand can be absent for several results. Keep following known
    // peers during that gap rather than letting their stale positions make
    // a gradually approaching peer look like the missing held hand.
    otherHandSnapshots.set(previous, others.map((other, index) => {
      const current = matched.get(index + 1);
      return current ? { wrist: { ...current.wrist }, label: current.label } : other;
    }));
    return null;
  }
  const selected = valid.filter(h => solo || (swapped ? h.palm.x > width * .5 : h.palm.x < width * .5))
    .sort((a, b) => (preferGrip ? Number(handGrip(b.points, false, b.gesture, b.worldPoints, gripOptions))
      - Number(handGrip(a.points, false, a.gesture, a.worldPoints, gripOptions)) : 0)
      || (finitePoint(anchor) ? distance(a.palm, anchor) - distance(b.palm, anchor) : 0)
      || (swapped ? b.palm.x - a.palm.x : a.palm.x - b.palm.x))[0] || null;
  return rememberControlHand(selected, valid);
}

export class TossGesture {
  constructor() { this.settings = { minSpeed: 200, minDistance: 40 }; this.cancel(); }
  configure(options = {}) {
    const normalized = normalizeTrackingTuning({
      minSpeed: Number.isFinite(options?.minSpeed) ? options.minSpeed : this.settings.minSpeed,
      minDistance: Number.isFinite(options?.minDistance) ? options.minDistance : this.settings.minDistance,
    });
    this.settings = { minSpeed: normalized.minSpeed, minDistance: normalized.minDistance };
    return this;
  }
  cancel() { this.active = false; this.history = []; this.start = null; }
  begin(point, time) {
    this.cancel();
    if (!finitePoint(point) || !Number.isFinite(time)) return;
    this.active = true; this.start = { ...point, time }; this.history = [{ ...point, time }];
  }
  move(point, time) {
    if (!this.active) return false;
    const previous = this.history.at(-1);
    if (!finitePoint(point) || !Number.isFinite(time) || time < previous.time || time - previous.time > MAX_SAMPLE_GAP) {
      this.cancel(); return false;
    }
    if (time === previous.time) this.history[this.history.length - 1] = { ...point, time };
    else this.history.push({ ...point, time });
    this.history = this.history.filter(p => time - p.time <= MAX_SAMPLE_GAP + RELEASE_GRACE);
    return true;
  }
  previewRelease(point, time, target) {
    return this.releaseResult(this.diagnostics(point, time, target));
  }
  diagnostics(point, time, target) {
    const preview = new TossGesture();
    preview.settings = { ...this.settings };
    preview.active = this.active;
    preview.start = this.start ? { ...this.start } : null;
    preview.history = this.history.map(sample => ({ ...sample }));
    return preview.evaluateRelease(point, time, target);
  }
  release(point, time, target) {
    return this.releaseResult(this.evaluateRelease(point, time, target));
  }
  releaseResult(result) {
    return result.ok ? { ok: true, fast: result.fast } : { ok: false, reason: result.reason };
  }
  evaluateRelease(point, time, target) {
    const finite = value => Number.isFinite(value) ? value : 0;
    const direction = finitePoint(this.start) && Number.isFinite(target?.x) ? Math.sign(target.x - this.start.x) || 1 : 0;
    const metrics = { speed: 0, travel: finitePoint(point) && finitePoint(this.start) ? finite((point.x - this.start.x) * direction) : 0,
      distance: finitePoint(point) && finitePoint(this.start) ? finite(distance(this.start, point)) : 0,
      duration: finite(time - this.start?.time), gap: finite(time - this.history.at(-1)?.time) };
    const outcome = (reason, fast = false) => ({ ok: reason === 'ready', reason, fast, ...metrics });
    if (!this.active) return outcome('cancelled');
    if (!target || !Number.isFinite(target.x)) { this.cancel(); return outcome('no-receiver'); }
    if (time - this.history.at(-1).time > MAX_SAMPLE_GAP) { this.cancel(); return outcome('slow'); }
    const priorSamples = this.history.slice();
    if (!this.move(point, time)) return outcome('cancelled');
    const history = this.history, start = this.start;
    const toward = (point.x - start.x) * direction;
    this.cancel();
    if (toward < 24) return outcome('direction');
    const recent = history.filter(p => time - p.time <= RELEASE_GRACE);
    if (recent.some(p => (p.x - point.x) * direction > 32)) return outcome('direction');
    // The opening observation cannot be the only evidence of a swing: a new
    // distant hand can otherwise look like a fast jump from a stationary hold.
    // Require forward motion already recorded before this release position.
    let priorForward = false;
    for (let j = 1; j < priorSamples.length; j++) {
      const last = priorSamples[j];
      if (time - last.time > 240) continue;
      for (let i = j - 1; i >= 0; i--) {
        const first = priorSamples[i], duration = last.time - first.time;
        if (duration > 240) break;
        if (duration < 25) continue;
        const travel = (last.x - first.x) * direction;
        if (travel >= 24 && travel / (duration / 1000) >= 200 && travel >= Math.abs(last.y - first.y)) {
          priorForward = true; break;
        }
      }
      if (priorForward) break;
    }
    // Opening the hand can be recognized one frame after the swing stops.
    // Look for recent forward motion, without counting a stationary release
    // as movement or averaging a fast flick away with the preceding hold.
    let speed = 0, fast = false;
    for (let j = 1; j < history.length; j++) {
      const last = history[j];
      if (time - last.time > RELEASE_GRACE || (last.x - history[j - 1].x) * direction < 2) continue;
      for (let i = j - 1; i >= 0; i--) {
        const first = history[i], duration = last.time - first.time;
        // Sparse consecutive observations are useful up to the tracking gap
        // limit; several observations only describe a flick over a short span.
        if (duration < 25 || (j - i > 1 && duration > 240)) continue;
        const travel = (last.x - first.x) * direction;
        const observedSpeed = travel / (duration / 1000);
        if (travel >= 24) speed = Math.max(speed, observedSpeed);
        // A confident open-hand observation can finish a clearly fast swing
        // immediately. Old motion or a mostly vertical movement cannot supply
        // that stronger evidence for bypassing release confirmation.
        if (priorForward && travel >= 160 && observedSpeed >= 1400 && travel >= Math.abs(last.y - first.y)
          && time - last.time <= 160) fast = true;
      }
    }
    metrics.speed = speed;
    const duration = time - start.time;
    // A real quick flick must not fail just because it finishes within 90ms.
    // Require substantially more travel and speed for that short observation.
    const quickFlick = duration >= 35 && toward >= 100 && speed >= 1000;
    if (speed < this.settings.minSpeed || (duration < 90 && !quickFlick) || metrics.distance < this.settings.minDistance) return outcome('slow');
    return outcome('ready', fast);
  }
}

export class DwellAction {
  constructor(duration = 1150) { this.duration = duration; this.reset(); }
  reset() { this.since = null; this.fired = false; }
  update(inside, time) {
    if (!inside) { this.reset(); return false; }
    if (this.since === null) this.since = time;
    if (!this.fired && time - this.since >= this.duration) { this.fired = true; return true; }
    return false;
  }
  progress(time) { return this.since === null ? 0 : clamp((time - this.since) / this.duration, 0, 1); }
}

export function flightPose(start, target, progress) {
  const t = clamp(progress, 0, 1), fly = clamp(t / .8, 0, 1), ease = 1 - (1 - fly) ** 2, drop = clamp((t - .8) / .2, 0, 1);
  return { x: start.x + (target.x - start.x) * ease,
    y: start.y + (target.y - 70 - start.y) * ease - Math.sin(fly * Math.PI) * 170 + 70 * drop ** 2,
    w: start.w + (target.w - start.w) * ease, h: start.h + (target.h - start.h) * ease,
    yaw: Math.sin(fly * Math.PI) * 2.4, pitch: -Math.sin(fly * Math.PI) * .5,
    roll: Math.sin(fly * Math.PI) * .4, depth: 1 + Math.sin(fly * Math.PI) * .25 };
}
