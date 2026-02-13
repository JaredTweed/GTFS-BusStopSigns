## Description

This website generates high quality bus stop signs from GTFS zip files. By default, it uses the GTFS file for Vancouver, BC's Translink. 

I heard that the largest reason for poor signage is due to the frequency of how often the routes get updated, so I wanted to create an efficient way for people to improve the signs through guerilla/tactical urbanism. I was inspired to make the website from this video:

[How to Fix Bus Stop Signs: Uytae Lee's Stories About Here](https://www.youtube.com/watch?v=0Z9gMVH-N8E)

## Examples

![alt text](examples/image.png)

![alt text](examples/image2.png)

![alt text](examples/image3.png)

## TODO

- Mass download of bus signs for large areas.
- Make lines look smoother when merging or splitting.
  - Modify how the line transitions into itself after it splits off, or another line splits off from its direction. Instead of suddenly shifting the line to be accurate (which can make it look like it jumps perpendicular to its direction of movement), make it transition directly to that color's position 10px (make this a varaible I can adjust) farther down, so that when splits/merges happen, they look more gradual so that the line doesn't cut at all. Just to reiterate, 10px after a split or preceeding a merge. And if the thickness of this line changes size/thickness during this transition, make it transition its size gradually as well. If I make it transition for 20px, the continuation of it should start only once that transition is complete.
<!-- 

## Smooth Merge/Split Idea:

odify how the line transitions into itself after it splits off, or another line splits off from its direction. Instead of suddenly shifting the line to be accurate (which can make it look like it jumps
  perpendicular to its direction of movement), make it transition directly to that color's position 10px (make this a varaible I can adjust) farther down, so that when splits/merges happen, they look more
  gradual so that the line doesn't cut at all. Just to reiterate, 10px after a split or preceeding a merge. And if the thickness of this line changes size/thickness during this transition, make it transition its
  size gradually as well.

• I’m going to inspect the shared/non-shared route drawing pipeline first, then add a configurable transition distance so split/merge lane and width changes ease over ~10px instead of snapping. I’ll apply it to
  both canvas and SVG so preview/export match.
• Explored
  └ Read app.js
    Search drawStripedPolylineOnCanvas|drawStripedPolylineOnMap|buildNonSharedRuns|buildSharedLaneChains|groupedRouteLineWidthForCount|offsetPolylinePixels|routePathSvg|sharedLaneSvg in app.js
    Read app.js
    Search drawStripedPolylineOnMap\(|drawStripedLineOnMap\(|L\.polyline\(lane in app.js
    Search clamp01|smoothstep|smoothStep|lerp\( in app.js
• Implementing lane state and transition drawing helpers
─ Worked for 2m 45s ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
• I identified the exact jump source: non-shared and shared lanes are drawn as separate fixed-offset strokes, so offset/width can change discontinuously at split/merge boundaries. I’m now adding a transition-
  length constant and geometric helpers to interpolate lane offset + width over that distance.
• Edited app.js (+1 -0)
    114  const SIGN_ROUTE_GROUP_LANE_OVERLAP_PX = 0.45;
    115 +const SIGN_ROUTE_SPLIT_MERGE_TRANSITION_PX = 10;
    116  const STOP_OVERLAY_TRIP_CANDIDATE_LIMIT = 24;
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
• Context compacted
• I’m implementing the split/merge transition smoothing now in app.js: I’ll add geometry helpers, then wire them into both canvas and SVG rendering so offset and width ease over an adjustable distance at split/
  merge boundaries. I’ll verify with syntax checks after patching.
• Explored
  └ Search SIGN_ROUTE_SPLIT_MERGE_TRANSITION_PX|buildSharedLanePlacementData|drawRoutePreviewOnCanvas|buildSignSvg|drawStripedPolylineOnCanvas|offsetPolylinePixels in app.js
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
• I confirmed the key rendering hooks and the new transition constant are present. I’m reading the lane placement and draw paths next so I can patch both preview and SVG consistently.
• Explored
  └ Read app.js
    Search function buildSharedEdges|function buildSharedLaneChains|sharedChains|roundCapStart|roundCapEnd|orderedRouteIds in app.js
    Read app.js
    Search drawStripedPolylineOnMap|offsetLatLonPolylineForMap|mapObj|L.polyline\( in app.js
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
• I’ve mapped where to patch: non-shared route strokes and shared-chain lane rendering in both canvas and SVG. Next I’m adding interpolation helpers so transitions use path-distance blending over
  SIGN_ROUTE_SPLIT_MERGE_TRANSITION_PX.
• Explored
  └ Read app.js
• Designing overlay strokes for smooth lane transitions
─ Worked for 2m 06s ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
• I’m patching the rendering algorithm now with explicit per-boundary transition overlays (offset + width interpolation) driven by route edge states, so both preview and SVG use the same smoothing logic.
• Edited app.js (+239 -0)
    2844
    2845 +function buildSharedLaneStateByEdgeKey(sharedEdges) {
    2846 +  const byEdgeKey = new Map();
    2847 +  if (!Array.isArray(sharedEdges) || sharedEdges.length === 0) return byEdgeKey;
    2848 +
    2849 +  for (const edge of sharedEdges) {
    2850 +    const orderedRouteIds = Array.isArray(edge?.orderedRouteIds) && edge.orderedRouteIds.length
    2851 +      ? edge.orderedRouteIds.slice()
    2852 +      : Array.from(edge?.routeIds || []).sort();
    2853 +    if (orderedRouteIds.length < 2) continue;
    2854 +
    2855 +    const groupCount = orderedRouteIds.length;
    2856 +    const groupedWidth = groupedRouteLineWidthForCount(groupCount);
    2857 +    const laneStep = Math.max(2, groupedWidth / groupCount);
    2858 +    const laneWidthPx = Math.max(2, laneStep + SIGN_ROUTE_GROUP_LANE_OVERLAP_PX);
    2859 +    const byRoute = new Map();
    2860 +    for (let i = 0; i < orderedRouteIds.length; i += 1) {
    2861 +      const rid = orderedRouteIds[i];
    2862 +      const offsetPx = ((i - ((groupCount - 1) / 2)) * laneStep);
    2863 +      byRoute.set(rid, { offsetPx, laneWidthPx, groupCount });
    2864 +    }
    2865 +    byEdgeKey.set(edge.key, byRoute);
    2866 +  }
    2867 +
    2868 +  return byEdgeKey;
    2869 +}
    2870 +
    2871 +function laneStateNearlyEqual(a, b) {
    2872 +  if (!a || !b) return false;
    2873 +  return Math.abs((a.offsetPx || 0) - (b.offsetPx || 0)) < 0.05
    2874 +    && Math.abs((a.laneWidthPx || 0) - (b.laneWidthPx || 0)) < 0.05;
    2875 +}
    2876 +
    2877 +function clamp01(v) {
    2878 +  return Math.max(0, Math.min(1, v));
    2879 +}
    2880 +
    2881 +function smoothstep01(v) {
    2882 +  const t = clamp01(v);
    2883 +  return t * t * (3 - (2 * t));
    2884 +}
    2885 +
    2886 +function buildPolylineMetrics(pixelPoints) {
    2887 +  if (!Array.isArray(pixelPoints) || pixelPoints.length < 2) return null;
    2888 +  const pts = [];
    2889 +  for (const p of pixelPoints) {
    2890 +    const x = Number(p?.x);
    2891 +    const y = Number(p?.y);
    2892 +    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    2893 +    pts.push({ x, y });
    2894 +  }
    2895 +  if (pts.length < 2) return null;
    2896 +
    2897 +  const cumulative = new Array(pts.length);
    2898 +  cumulative[0] = 0;
    2899 +  let total = 0;
    2900 +  for (let i = 1; i < pts.length; i += 1) {
    2901 +    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    2902 +    cumulative[i] = total;
    2903 +  }
    2904 +  return { points: pts, cumulative, total };
    2905 +}
    2906 +
    2907 +function polylinePointAndNormalAtDistance(metrics, distancePx) {
    2908 +  if (!metrics || !Array.isArray(metrics.points) || metrics.points.length < 2) return null;
    2909 +  const points = metrics.points;
    2910 +  const cumulative = metrics.cumulative;
    2911 +  const total = Number(metrics.total) || 0;
    2912 +  if (total <= 1e-9) {
    2913 +    return { x: points[0].x, y: points[0].y, nx: 0, ny: -1 };
    2914 +  }
    2915 +
    2916 +  const d = Math.max(0, Math.min(total, Number(distancePx) || 0));
    2917 +  let segEndIdx = 1;
    2918 +  while (segEndIdx < cumulative.length && cumulative[segEndIdx] < d) segEndIdx += 1;
    2919 +  if (segEndIdx >= points.length) segEndIdx = points.length - 1;
    2920 +
    2921 +  let a = points[segEndIdx - 1];
    2922 +  let b = points[segEndIdx];
    2923 +  let segLen = Math.hypot(b.x - a.x, b.y - a.y);
    2924 +  if (segLen <= 1e-9) {
    2925 +    for (let i = segEndIdx; i < points.length - 1; i += 1) {
    2926 +      const aa = points[i];
    2927 +      const bb = points[i + 1];
    2928 +      const ll = Math.hypot(bb.x - aa.x, bb.y - aa.y);
    2929 +      if (ll > 1e-9) {
    2930 +        a = aa;
    2931 +        b = bb;
    2932 +        segLen = ll;
    2933 +        break;
    2934 +      }
    2935 +    }
    2936 +  }
    2937 +  if (segLen <= 1e-9) {
    2938 +    for (let i = segEndIdx - 1; i >= 1; i -= 1) {
    2939 +      const aa = points[i - 1];
    2940 +      const bb = points[i];
    2941 +      const ll = Math.hypot(bb.x - aa.x, bb.y - aa.y);
    2942 +      if (ll > 1e-9) {
    2943 +        a = aa;
    2944 +        b = bb;
    2945 +        segLen = ll;
    2946 +        break;
    2947 +      }
    2948 +    }
    2949 +  }
    2950 +  if (segLen <= 1e-9) {
    2951 +    return { x: a.x, y: a.y, nx: 0, ny: -1 };
    2952 +  }
    2953 +
    2954 +  const segStartDist = cumulative[segEndIdx - 1];
    2955 +  const localT = clamp01((d - segStartDist) / segLen);
    2956 +  const x = a.x + ((b.x - a.x) * localT);
    2957 +  const y = a.y + ((b.y - a.y) * localT);
    2958 +  const tx = (b.x - a.x) / segLen;
    2959 +  const ty = (b.y - a.y) / segLen;
    2960 +  return { x, y, nx: -ty, ny: tx };
    2961 +}
    2962 +
    2963 +function buildTransitionSamples(metrics, startDist, endDist, fromState, toState) {
    2964 +  if (!metrics || !fromState || !toState) return [];
    2965 +  const a = Number(startDist);
    2966 +  const b = Number(endDist);
    2967 +  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return [];
    2968 +  const span = b - a;
    2969 +  const steps = Math.max(2, Math.ceil(span / 1.2));
    2970 +  const out = [];
    2971 +  for (let i = 0; i <= steps; i += 1) {
    2972 +    const t = i / steps;
    2973 +    const eased = smoothstep01(t);
    2974 +    const d = a + (span * t);
    2975 +    const center = polylinePointAndNormalAtDistance(metrics, d);
    2976 +    if (!center) continue;
    2977 +    const offsetPx = (fromState.offsetPx || 0) + (((toState.offsetPx || 0) - (fromState.offsetPx || 0)) * eased);
    2978 +    const laneWidthPx = (fromState.laneWidthPx || 0) + (((toState.laneWidthPx || 0) - (fromState.laneWidthPx || 0)) * eased);
    2979 +    out.push({
    2980 +      x: center.x + (center.nx * offsetPx),
    2981 +      y: center.y + (center.ny * offsetPx),
    2982 +      laneWidthPx: Math.max(1, laneWidthPx),
    2983 +    });
    2984 +  }
    2985 +  return out;
    2986 +}
    2987 +
    2988 +function drawTransitionSamplesOnCanvas(ctx, color, samples) {
    2989 +  if (!ctx || !color || !Array.isArray(samples) || samples.length < 2) return;
    2990 +  ctx.strokeStyle = color;
    2991 +  ctx.lineCap = "round";
    2992 +  ctx.lineJoin = "round";
    2993 +  for (let i = 1; i < samples.length; i += 1) {
    2994 +    const a = samples[i - 1];
    2995 +    const b = samples[i];
    2996 +    const w = Math.max(1, (a.laneWidthPx + b.laneWidthPx) / 2);
    2997 +    ctx.lineWidth = w;
    2998 +    ctx.beginPath();
    2999 +    ctx.moveTo(a.x, a.y);
    3000 +    ctx.lineTo(b.x, b.y);
    3001 +    ctx.stroke();
    3002 +  }
    3003 +}
    3004 +
    3005 +function buildTransitionSamplesSvg(color, samples) {
    3006 +  if (!color || !Array.isArray(samples) || samples.length < 2) return [];
    3007 +  const parts = [];
    3008 +  for (let i = 1; i < samples.length; i += 1) {
    3009 +    const a = samples[i - 1];
    3010 +    const b = samples[i];
    3011 +    const w = Math.max(1, (a.laneWidthPx + b.laneWidthPx) / 2);
    3012 +    parts.push(
    3013 +      `<line x1="${a.x.toFixed(2)}" y1="${a.y.toFixed(2)}" x2="${b.x.toFixed(2)}" y2="${b.y.toFixed(2)}" stroke="${color}" stroke-width="${w.toFixed(2)}" stroke-linecap="round" />`,
    3014 +    );
    3015 +  }
    3016 +  return parts;
    3017 +}
    3018 +
    3019 +function buildSegmentLaneTransitions(seg, pixelPoints, sharedLaneStateByEdgeKey) {
    3020 +  const transitions = [];
    3021 +  if (!seg || !Array.isArray(seg.points) || seg.points.length < 3 || !Array.isArray(pixelPoints) || pixelPoints.length < 3) {
    3022 +    return { metrics: buildPolylineMetrics(pixelPoints), transitions };
    3023 +  }
    3024 +
    3025 +  const metrics = buildPolylineMetrics(pixelPoints);
    3026 +  if (!metrics || metrics.total <= 1e-9) return { metrics, transitions };
    3027 +
    3028 +  const transitionPx = Math.max(0, Number(SIGN_ROUTE_SPLIT_MERGE_TRANSITION_PX) || 0);
    3029 +  if (transitionPx <= 0) return { metrics, transitions };
    3030 +
    3031 +  const rid = seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`;
    3032 +  const baseState = {
    3033 +    offsetPx: 0,
    3034 +    laneWidthPx: groupedRouteLineWidthForCount(1),
    3035 +    groupCount: 1,
    3036 +  };
    3037 +
    3038 +  const edgeStates = new Array(seg.points.length - 1);
    3039 +  for (let i = 0; i < seg.points.length - 1; i += 1) {
    3040 +    const eKey = edgeKey(seg.points[i], seg.points[i + 1]);
    3041 +    const byRoute = sharedLaneStateByEdgeKey.get(eKey);
    3042 +    edgeStates[i] = byRoute?.get(rid) || baseState;
    3043 +  }
    3044 +
    3045 +  for (let i = 1; i < edgeStates.length; i += 1) {
    3046 +    const prevState = edgeStates[i - 1];
    3047 +    const nextState = edgeStates[i];
    3048 +    if (laneStateNearlyEqual(prevState, nextState)) continue;
    3049 +
    3050 +    const vertexDist = metrics.cumulative[i];
    3051 +    if (!Number.isFinite(vertexDist)) continue;
    3052 +
    3053 +    let startDist = 0;
    3054 +    let endDist = 0;
    3055 +    const prevCount = Number(prevState.groupCount) || 1;
    3056 +    const nextCount = Number(nextState.groupCount) || 1;
    3057 +    if (prevCount > nextCount) {
    3058 +      // Split: transition after the split point.
    3059 +      startDist = vertexDist;
    3060 +      endDist = Math.min(metrics.total, vertexDist + transitionPx);
    3061 +    } else if (prevCount < nextCount) {
    3062 +      // Merge: transition before the merge point.
    3063 +      startDist = Math.max(0, vertexDist - transitionPx);
    3064 +      endDist = vertexDist;
    3065 +    } else {
    3066 +      // Lateral reorder with equal group size.
    3067 +      const half = transitionPx / 2;
    3068 +      startDist = Math.max(0, vertexDist - half);
    3069 +      endDist = Math.min(metrics.total, vertexDist + half);
    3070 +    }
    3071 +
    3072 +    if (!Number.isFinite(startDist) || !Number.isFinite(endDist) || endDist - startDist < 0.5) continue;
    3073 +    transitions.push({
    3074 +      startDist,
    3075 +      endDist,
    3076 +      fromState: prevState,
    3077 +      toState: nextState,
    3078 +    });
    3079 +  }
    3080 +
    3081 +  return { metrics, transitions };
    3082 +}
    3083 +
    3084  function markerPixelPositionOnRouteLane(seg, marker, projectPointToPixel, segPixelPointsCache, sharedLaneByRouteId) {
• Explored
  └ Read app.js
    Search async function drawRoutePreviewOnCanvas in app.js
    Read app.js
• Edited app.js (+19 -0)
    3819    );
    3820 +  const sharedLaneStateByEdgeKey = buildSharedLaneStateByEdgeKey(sharedEdges);
    3821    const sharedEdgeKeySet = new Set(sharedEdges.map((e) => e.key));
         ⋮
    3861
    3862 +  for (const seg of segments) {
    3863 +    const segKey = seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`;
    3864 +    let segPixelPoints = segPixelPointsCache.get(segKey);
    3865 +    if (!segPixelPoints) {
    3866 +      segPixelPoints = seg.points.map(([lat, lon]) => {
    3867 +        const [px, py] = project(lat, lon);
    3868 +        return { x: px, y: py };
    3869 +      });
    3870 +      segPixelPointsCache.set(segKey, segPixelPoints);
    3871 +    }
    3872 +    const { metrics, transitions } = buildSegmentLaneTransitions(seg, segPixelPoints, sharedLaneStateByEdgeKey);
    3873 +    if (!metrics || transitions.length === 0) continue;
    3874 +    for (const tr of transitions) {
    3875 +      const samples = buildTransitionSamples(metrics, tr.startDist, tr.endDist, tr.fromState, tr.toState);
    3876 +      drawTransitionSamplesOnCanvas(ctx, seg.lineColor, samples);
    3877 +    }
    3878 +  }
    3879 +
    3880    if (showStops && routeStopMarkersBySegment instanceof Map) {
• Explored
  └ Search async function buildSignSvg|const sharedEdgeKeySet|const routePathSvg =|const sharedLaneSvg =|const routeStopsSvg in app.js
    Read app.js
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
• I’m wiring the same transition pass into SVG export so the downloaded map matches the on-screen preview exactly, including gradual offset and width changes.
• Edited app.js (+21 -0)
    4496    );
    4497 +  const sharedLaneStateByEdgeKey = buildSharedLaneStateByEdgeKey(sharedEdges);
    4498    const segPixelPointsCache = new Map();
         ⋮
    4595
    4596 +  const transitionSvg = [];
    4597 +  for (const seg of routeSegments) {
    4598 +    const segKey = seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`;
    4599 +    let segPixelPoints = segPixelPointsCache.get(segKey);
    4600 +    if (!segPixelPoints) {
    4601 +      segPixelPoints = seg.points.map(([lat, lon]) => {
    4602 +        const [px, py] = project(lat, lon);
    4603 +        return { x: px, y: py };
    4604 +      });
    4605 +      segPixelPointsCache.set(segKey, segPixelPoints);
    4606 +    }
    4607 +    const { metrics, transitions } = buildSegmentLaneTransitions(seg, segPixelPoints, sharedLaneStateByEdgeKey);
    4608 +    if (!metrics || transitions.length === 0) continue;
    4609 +    for (const tr of transitions) {
    4610 +      const samples = buildTransitionSamples(metrics, tr.startDist, tr.endDist, tr.fromState, tr.toState);
    4611 +      transitionSvg.push(...buildTransitionSamplesSvg(seg.lineColor, samples));
    4612 +    }
    4613 +  }
    4614 +
    4615    const routeStopsSvg = [];
         ⋮
    4684    ${sharedLaneSvg.join("")}
    4685 +  ${transitionSvg.join("")}
    4686    ${routeStopsSvg.join("")}
• Ran node --check app.js
  └ (no output)
• Ran git diff -- app.js | sed -n '1,260p'
  └ diff --git a/app.js b/app.js
    index 62c543d..cf3148a 100644
    … +256 lines
    @@ -3577,6 +3817,7 @@ async function drawRoutePreviewOnCanvas(ctx, {
         sharedChains,
• Ran git diff -- app.js | sed -n '260,520p'
  └      sharedChains,
         (lat, lon) => project(lat, lon),
    … +70 lines
       ${stopPt ? `<circle cx="${stopPt[0].toFixed(2)}" cy="${stopPt[1].toFixed(2)}" r="6" fill="#ffffff" stroke="#111111" stroke-width="2" />` : ""}
       ${legendSvg.join("")}
• Explored
  └ Search function clamp01\( in app.js
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
• I’ve finished the algorithm patch and validated syntax. I’m grabbing exact line references so you can quickly review the core transition logic.
• Explored
  └ Search SIGN_ROUTE_SPLIT_MERGE_TRANSITION_PX|buildSharedLaneStateByEdgeKey|buildSegmentLaneTransitions|buildTransitionSamples\(|drawTransitionSamplesOnCanvas|buildTransitionSamplesSvg|const transitionSvg = in
           app.js
    Read app.js
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
• Implemented the transition algorithm in app.js so split/merge lane changes are now gradual (position + thickness) and consistent between preview and SVG.

  - Added adjustable transition distance: SIGN_ROUTE_SPLIT_MERGE_TRANSITION_PX at app.js:115.
  - Added lane-state + transition engine:
      - Shared edge lane-state extraction at app.js:2845.
      - Transition detection per segment boundary at app.js:3019.
      - Split logic: transition after boundary (app.js:3057).
      - Merge logic: transition before boundary (app.js:3061).
      - Offset/width easing via smoothstep samples (app.js:2963).
  - Applied to canvas map rendering at app.js:3862.
  - Applied to SVG export rendering at app.js:4596.

  This makes the rendered map match the event/order model and removes the abrupt perpendicular “jump” effect.
  Validation run: node --check app.js passed.

› is setting the "SIGN_ROUTE_SPLIT_MERGE_TRANSITION_PX" to 0 gonna make it act equivalently to before this change?

• Yes. Setting SIGN_ROUTE_SPLIT_MERGE_TRANSITION_PX = 0 makes it render like before this feature.

  The transition pass exits early when the value is <= 0, so no smoothing overlay is drawn, and you get the original hard split/merge jumps again. The only difference is negligible extra computation from checking
  transitions.

› if I make it transition for 20px, the continuation of it should start only once that transition is complete. If that is not how it is designed. Can you make it work that way?

• Planning precise run trimming implementation
• You’re right: with the current overlay approach, continuation can still appear before the transition window ends. I’m updating the draw algorithm so base continuation is clipped out inside the transition
  interval, then only starts after it completes.
• Edited app.js (+73 -0)
    2718
    2719 +function buildNonSharedRunsWithIndexes(points, sharedEdgeKeySet) {
    2720 +  if (!Array.isArray(points) || points.length < 2) return [];
    2721 +  if (!sharedEdgeKeySet || sharedEdgeKeySet.size === 0) {
    2722 +    return [{ startIdx: 0, endIdx: points.length - 1, points: points.slice() }];
    2723 +  }
    2724 +
    2725 +  const runs = [];
    2726 +  let runStartIdx = -1;
    2727 +
    2728 +  for (let i = 1; i < points.length; i += 1) {
    2729 +    const a = points[i - 1];
    2730 +    const b = points[i];
    2731 +    const isShared = sharedEdgeKeySet.has(edgeKey(a, b));
    2732 +
    2733 +    if (isShared) {
    2734 +      if (runStartIdx >= 0 && (i - 1) - runStartIdx >= 1) {
    2735 +        runs.push({
    2736 +          startIdx: runStartIdx,
    2737 +          endIdx: i - 1,
    2738 +          points: points.slice(runStartIdx, i),
    2739 +        });
    2740 +      }
    2741 +      runStartIdx = -1;
    2742 +      continue;
    2743 +    }
    2744 +
    2745 +    if (runStartIdx < 0) runStartIdx = i - 1;
    2746 +  }
    2747 +
    2748 +  if (runStartIdx >= 0 && (points.length - 1) - runStartIdx >= 1) {
    2749 +    runs.push({
    2750 +      startIdx: runStartIdx,
    2751 +      endIdx: points.length - 1,
    2752 +      points: points.slice(runStartIdx),
    2753 +    });
    2754 +  }
    2755 +
    2756 +  return runs;
    2757 +}
    2758 +
    2759 +function subtractIntervalsFromRange(start, end, intervals) {
    2760 +  const a = Number(start);
    2761 +  const b = Number(end);
    2762 +  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return [];
    2763 +  if (!Array.isArray(intervals) || intervals.length === 0) return [{ start: a, end: b }];
    2764 +
    2765 +  const clipped = [];
    2766 +  for (const it of intervals) {
    2767 +    const s = Math.max(a, Number(it?.start));
    2768 +    const e = Math.min(b, Number(it?.end));
    2769 +    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    2770 +    clipped.push({ start: s, end: e });
    2771 +  }
    2772 +  if (clipped.length === 0) return [{ start: a, end: b }];
    2773 +
    2774 +  clipped.sort((x, y) => x.start - y.start || x.end - y.end);
    2775 +  const merged = [];
    2776 +  for (const it of clipped) {
    2777 +    const last = merged[merged.length - 1];
    2778 +    if (!last || it.start > last.end) merged.push({ ...it });
    2779 +    else last.end = Math.max(last.end, it.end);
    2780 +  }
    2781 +
    2782 +  const remain = [];
    2783 +  let cursor = a;
    2784 +  for (const it of merged) {
    2785 +    if (it.start > cursor) remain.push({ start: cursor, end: it.start });
    2786 +    cursor = Math.max(cursor, it.end);
    2787 +  }
    2788 +  if (cursor < b) remain.push({ start: cursor, end: b });
    2789 +  return remain.filter((r) => (r.end - r.start) > 0.5);
    2790 +}
    2791 +
    2792  function groupedRouteLineWidthForCount(groupCount) {
• Edited app.js (+40 -0)
    3091
    3092 +function buildPolylineSlicePoints(metrics, startDist, endDist) {
    3093 +  if (!metrics || !Array.isArray(metrics.points) || metrics.points.length < 2) return [];
    3094 +  const total = Number(metrics.total) || 0;
    3095 +  if (total <= 1e-9) return [];
    3096 +
    3097 +  const s = Math.max(0, Math.min(total, Number(startDist) || 0));
    3098 +  const e = Math.max(0, Math.min(total, Number(endDist) || 0));
    3099 +  if (e - s <= 0.5) return [];
    3100 +
    3101 +  const sp = polylinePointAndNormalAtDistance(metrics, s);
    3102 +  const ep = polylinePointAndNormalAtDistance(metrics, e);
    3103 +  if (!sp || !ep) return [];
    3104 +
    3105 +  const out = [{ x: sp.x, y: sp.y }];
    3106 +  for (let i = 1; i < metrics.points.length - 1; i += 1) {
    3107 +    const d = metrics.cumulative[i];
    3108 +    if (d > s + 1e-4 && d < e - 1e-4) out.push(metrics.points[i]);
    3109 +  }
    3110 +  if (Math.hypot(out[out.length - 1].x - ep.x, out[out.length - 1].y - ep.y) > 1e-4) {
    3111 +    out.push({ x: ep.x, y: ep.y });
    3112 +  }
    3113 +
    3114 +  return out.length >= 2 ? out : [];
    3115 +}
    3116 +
    3117 +function drawCenterPolylineOnCanvas(ctx, pixelPoints, color, width) {
    3118 +  if (!ctx || !Array.isArray(pixelPoints) || pixelPoints.length < 2 || !color) return;
    3119 +  ctx.strokeStyle = color;
    3120 +  ctx.lineWidth = width;
    3121 +  ctx.lineCap = "round";
    3122 +  ctx.lineJoin = "round";
    3123 +  ctx.beginPath();
    3124 +  for (let i = 0; i < pixelPoints.length; i += 1) {
    3125 +    const p = pixelPoints[i];
    3126 +    if (i === 0) ctx.moveTo(p.x, p.y);
    3127 +    else ctx.lineTo(p.x, p.y);
    3128 +  }
    3129 +  ctx.stroke();
    3130 +}
    3131 +
    3132  function buildSegmentLaneTransitions(seg, pixelPoints, sharedLaneStateByEdgeKey) {
• Edited app.js (+36 -23)
    3935    const segPixelPointsCache = new Map();
    3936 +  const transitionBySegKey = new Map();
    3937
    3938    for (const seg of segments) {
    3938 -    const runs = buildNonSharedRuns(seg.points, sharedEdgeKeySet);
    3939 -    for (const run of runs) {
    3940 -      const pixelPoints = run.map(([lat, lon]) => {
    3939 +    const segKey = seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`;
    3940 +    let segPixelPoints = segPixelPointsCache.get(segKey);
    3941 +    if (!segPixelPoints) {
    3942 +      segPixelPoints = seg.points.map(([lat, lon]) => {
    3943          const [px, py] = project(lat, lon);
         ⋮
    3945        });
    3944 -      if (pixelPoints.length < 2) continue;
    3946 +      segPixelPointsCache.set(segKey, segPixelPoints);
    3947 +    }
    3948 +    transitionBySegKey.set(
    3949 +      segKey,
    3950 +      buildSegmentLaneTransitions(seg, segPixelPoints, sharedLaneStateByEdgeKey),
    3951 +    );
    3952 +  }
    3953
    3946 -      ctx.strokeStyle = seg.lineColor;
    3947 -      ctx.lineWidth = groupedRouteLineWidthForCount(1);
    3948 -      ctx.lineCap = "round";
    3949 -      ctx.lineJoin = "round";
    3950 -      ctx.beginPath();
    3951 -      for (let i = 0; i < pixelPoints.length; i += 1) {
    3952 -        const p = pixelPoints[i];
    3953 -        if (i === 0) ctx.moveTo(p.x, p.y);
    3954 -        else ctx.lineTo(p.x, p.y);
    3954 +  for (const seg of segments) {
    3955 +    const segKey = seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`;
    3956 +    const segTransition = transitionBySegKey.get(segKey);
    3957 +    const metrics = segTransition?.metrics;
    3958 +    const transitions = Array.isArray(segTransition?.transitions) ? segTransition.transitions : [];
    3959 +    const cutIntervals = transitions.map((t) => ({ start: t.startDist, end: t.endDist }));
    3960 +    const runs = buildNonSharedRunsWithIndexes(seg.points, sharedEdgeKeySet);
    3961 +    for (const run of runs) {
    3962 +      if (!metrics || !Array.isArray(metrics.cumulative) || run.endIdx >= metrics.cumulative.length) {
    3963 +        const pixelPoints = run.points.map(([lat, lon]) => {
    3964 +          const [px, py] = project(lat, lon);
    3965 +          return { x: px, y: py };
    3966 +        });
    3967 +        drawCenterPolylineOnCanvas(ctx, pixelPoints, seg.lineColor, groupedRouteLineWidthForCount(1));
    3968 +        continue;
    3969        }
    3956 -      ctx.stroke();
    3970 +
    3971 +      const runStart = metrics.cumulative[run.startIdx];
    3972 +      const runEnd = metrics.cumulative[run.endIdx];
    3973 +      const keptRanges = subtractIntervalsFromRange(runStart, runEnd, cutIntervals);
    3974 +      for (const kept of keptRanges) {
    3975 +        const slice = buildPolylineSlicePoints(metrics, kept.start, kept.end);
    3976 +        drawCenterPolylineOnCanvas(ctx, slice, seg.lineColor, groupedRouteLineWidthForCount(1));
    3977 +      }
    3978      }
         ⋮
    3997      const segKey = seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`;
    3977 -    let segPixelPoints = segPixelPointsCache.get(segKey);
    3978 -    if (!segPixelPoints) {
    3979 -      segPixelPoints = seg.points.map(([lat, lon]) => {
    3980 -        const [px, py] = project(lat, lon);
    3981 -        return { x: px, y: py };
    3982 -      });
    3983 -      segPixelPointsCache.set(segKey, segPixelPoints);
    3984 -    }
    3985 -    const { metrics, transitions } = buildSegmentLaneTransitions(seg, segPixelPoints, sharedLaneStateByEdgeKey);
    3998 +    const { metrics, transitions } = transitionBySegKey.get(segKey) || {};
    3999      if (!metrics || transitions.length === 0) continue;
• Edited app.js (+42 -15)
    4624    const segPixelPointsCache = new Map();
    4625 +  const transitionBySegKey = new Map();
    4626
    4627 +  for (const seg of routeSegments) {
    4628 +    const segKey = seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`;
    4629 +    let segPixelPoints = segPixelPointsCache.get(segKey);
    4630 +    if (!segPixelPoints) {
    4631 +      segPixelPoints = seg.points.map(([lat, lon]) => {
    4632 +        const [px, py] = project(lat, lon);
    4633 +        return { x: px, y: py };
    4634 +      });
    4635 +      segPixelPointsCache.set(segKey, segPixelPoints);
    4636 +    }
    4637 +    transitionBySegKey.set(
    4638 +      segKey,
    4639 +      buildSegmentLaneTransitions(seg, segPixelPoints, sharedLaneStateByEdgeKey),
    4640 +    );
    4641 +  }
    4642 +
    4643    const stopLat = safeParseFloat(stop.stop_lat);
         ⋮
    4693    for (const seg of routeSegments) {
    4677 -    const runs = buildNonSharedRuns(seg.points, sharedEdgeKeySet);
    4694 +    const segKey = seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`;
    4695 +    const segTransition = transitionBySegKey.get(segKey);
    4696 +    const metrics = segTransition?.metrics;
    4697 +    const transitions = Array.isArray(segTransition?.transitions) ? segTransition.transitions : [];
    4698 +    const cutIntervals = transitions.map((t) => ({ start: t.startDist, end: t.endDist }));
    4699 +    const runs = buildNonSharedRunsWithIndexes(seg.points, sharedEdgeKeySet);
    4700      for (const run of runs) {
    4679 -      const d = run.map(([lat, lon], i) => {
    4680 -        const [x, y] = project(lat, lon);
    4681 -        return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    4682 -      }).join(" ");
    4683 -      routePathSvg.push(`<path d="${d}" fill="none" stroke="${seg.lineColor}" stroke-width="${groupedRouteLineWidthForCount(1)}" stroke-linecap="round" stroke-linejoin="round" />`);
    4701 +      if (!metrics || !Array.isArray(metrics.cumulative) || run.endIdx >= metrics.cumulative.length) {
    4702 +        const dFallback = run.points.map(([lat, lon], i) => {
    4703 +          const [x, y] = project(lat, lon);
    4704 +          return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    4705 +        }).join(" ");
    4706 +        routePathSvg.push(`<path d="${dFallback}" fill="none" stroke="${seg.lineColor}" stroke-width="${groupedRouteLineWidthForCount(1)}" stroke-linecap="round" stroke-linejoin="round" />`);
    4707 +        continue;
    4708 +      }
    4709 +
    4710 +      const runStart = metrics.cumulative[run.startIdx];
    4711 +      const runEnd = metrics.cumulative[run.endIdx];
    4712 +      const keptRanges = subtractIntervalsFromRange(runStart, runEnd, cutIntervals);
    4713 +      for (const kept of keptRanges) {
    4714 +        const slice = buildPolylineSlicePoints(metrics, kept.start, kept.end);
    4715 +        if (slice.length < 2) continue;
    4716 +        const d = slice.map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
    4717 +        routePathSvg.push(`<path d="${d}" fill="none" stroke="${seg.lineColor}" stroke-width="${groupedRouteLineWidthForCount(1)}" stroke-linecap="round" stroke-linejoin="round" />`);
    4718 +      }
    4719      }
         ⋮
    4759      const segKey = seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`;
    4725 -    let segPixelPoints = segPixelPointsCache.get(segKey);
    4726 -    if (!segPixelPoints) {
    4727 -      segPixelPoints = seg.points.map(([lat, lon]) => {
    4728 -        const [px, py] = project(lat, lon);
    4729 -        return { x: px, y: py };
    4730 -      });
    4731 -      segPixelPointsCache.set(segKey, segPixelPoints);
    4732 -    }
    4733 -    const { metrics, transitions } = buildSegmentLaneTransitions(seg, segPixelPoints, sharedLaneStateByEdgeKey);
    4760 +    const { metrics, transitions } = transitionBySegKey.get(segKey) || {};
    4761      if (!metrics || transitions.length === 0) continue;
• Edited app.js (+2 -2)
    3998      const { metrics, transitions } = transitionBySegKey.get(segKey) || {};
    3999 -    if (!metrics || transitions.length === 0) continue;
    3999 +    if (!metrics || !Array.isArray(transitions) || transitions.length === 0) continue;
    4000      for (const tr of transitions) {
         ⋮
    4760      const { metrics, transitions } = transitionBySegKey.get(segKey) || {};
    4761 -    if (!metrics || transitions.length === 0) continue;
    4761 +    if (!metrics || !Array.isArray(transitions) || transitions.length === 0) continue;
    4762      for (const tr of transitions) {
• Explored
  └ Search buildNonSharedRunsWithIndexes|subtractIntervalsFromRange|buildPolylineSlicePoints|transitionBySegKey in app.js
    Search function buildSegmentLaneTransitions|function buildSharedLaneStateByEdgeKey|function buildPolylineSlicePoints|function drawCenterPolylineOnCanvas in app.js
    Read app.js
─ Worked for 3m 26s ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
• I found a more complete way to satisfy this: I’m switching the base stroke rendering to be transition-aware across the full route state (shared and non-shared), so continuation is excluded from the transition
  window everywhere, not just on non-shared runs.
• Edited app.js (+4 -4)
    3134    if (!seg || !Array.isArray(seg.points) || seg.points.length < 3 || !Array.isArray(pixelPoints) || pixelPoints.length < 3) {
    3135 -    return { metrics: buildPolylineMetrics(pixelPoints), transitions };
    3135 +    return { metrics: buildPolylineMetrics(pixelPoints), edgeStates: [], transitions };
    3136    }
         ⋮
    3138    const metrics = buildPolylineMetrics(pixelPoints);
    3139 -  if (!metrics || metrics.total <= 1e-9) return { metrics, transitions };
    3139 +  if (!metrics || metrics.total <= 1e-9) return { metrics, edgeStates: [], transitions };
    3140
    3141    const transitionPx = Math.max(0, Number(SIGN_ROUTE_SPLIT_MERGE_TRANSITION_PX) || 0);
    3142 -  if (transitionPx <= 0) return { metrics, transitions };
    3142
         ⋮
    3155    }
    3156 +  if (transitionPx <= 0) return { metrics, edgeStates, transitions };
    3157
         ⋮
    3193
    3194 -  return { metrics, transitions };
    3194 +  return { metrics, edgeStates, transitions };
    3195  }
• Edited app.js (+14 -0)
    3131
    3132 +function laneStateAtDistance(edgeStates, cumulative, distancePx, fallbackState) {
    3133 +  const fallback = fallbackState || { offsetPx: 0, laneWidthPx: groupedRouteLineWidthForCount(1), groupCount: 1 };
    3134 +  if (!Array.isArray(edgeStates) || edgeStates.length === 0 || !Array.isArray(cumulative) || cumulative.length < 2) {
    3135 +    return fallback;
    3136 +  }
    3137 +
    3138 +  const d = Number(distancePx);
    3139 +  if (!Number.isFinite(d)) return edgeStates[0] || fallback;
    3140 +
    3141 +  let idx = 0;
    3142 +  while (idx < edgeStates.length - 1 && cumulative[idx + 1] <= d) idx += 1;
    3143 +  return edgeStates[idx] || fallback;
    3144 +}
    3145 +
    3146  function buildSegmentLaneTransitions(seg, pixelPoints, sharedLaneStateByEdgeKey) {
• Edited app.js (+26 -33)
    3972      const transitions = Array.isArray(segTransition?.transitions) ? segTransition.transitions : [];
    3973 -    const cutIntervals = transitions.map((t) => ({ start: t.startDist, end: t.endDist }));
    3974 -    const runs = buildNonSharedRunsWithIndexes(seg.points, sharedEdgeKeySet);
    3975 -    for (const run of runs) {
    3976 -      if (!metrics || !Array.isArray(metrics.cumulative) || run.endIdx >= metrics.cumulative.length) {
    3977 -        const pixelPoints = run.points.map(([lat, lon]) => {
    3978 -          const [px, py] = project(lat, lon);
    3979 -          return { x: px, y: py };
    3980 -        });
    3981 -        drawCenterPolylineOnCanvas(ctx, pixelPoints, seg.lineColor, groupedRouteLineWidthForCount(1));
    3982 -        continue;
    3983 -      }
    3984 -
    3985 -      const runStart = metrics.cumulative[run.startIdx];
    3986 -      const runEnd = metrics.cumulative[run.endIdx];
    3987 -      const keptRanges = subtractIntervalsFromRange(runStart, runEnd, cutIntervals);
    3988 -      for (const kept of keptRanges) {
    3989 -        const slice = buildPolylineSlicePoints(metrics, kept.start, kept.end);
    3990 -        drawCenterPolylineOnCanvas(ctx, slice, seg.lineColor, groupedRouteLineWidthForCount(1));
    3991 -      }
    3973 +    const edgeStates = Array.isArray(segTransition?.edgeStates) ? segTransition.edgeStates : [];
    3974 +    if (!metrics || !Array.isArray(metrics.cumulative) || !Number.isFinite(metrics.total) || metrics.total <= 0) {
    3975 +      const fallbackPts = seg.points.map(([lat, lon]) => {
    3976 +        const [px, py] = project(lat, lon);
    3977 +        return { x: px, y: py };
    3978 +      });
    3979 +      drawCenterPolylineOnCanvas(ctx, fallbackPts, seg.lineColor, groupedRouteLineWidthForCount(1));
    3980 +      continue;
    3981      }
    3993 -  }
    3982
    3995 -  for (const chain of sharedChains) {
    3996 -    const pixelPoints = chain.points.map(([lat, lon]) => {
    3997 -      const [px, py] = project(lat, lon);
    3998 -      return { x: px, y: py };
    3999 -    });
    4000 -    const groupedWidth = groupedRouteLineWidthForCount(chain.colors?.length || 0);
    4001 -    drawStripedPolylineOnCanvas(ctx, pixelPoints, chain.colors, groupedWidth, {
    4002 -      lineCap: "butt",
    4003 -      simplifyTolerancePx: SIGN_ROUTE_GROUP_SIMPLIFY_TOLERANCE_PX,
    4004 -      laneOverlapPx: SIGN_ROUTE_GROUP_LANE_OVERLAP_PX,
    4005 -      roundCapStart: !!chain.roundCapStart,
    4006 -      roundCapEnd: !!chain.roundCapEnd,
    4007 -    });
    3983 +    const cutIntervals = transitions.map((t) => ({ start: t.startDist, end: t.endDist }));
    3984 +    const keptRanges = subtractIntervalsFromRange(0, metrics.total, cutIntervals);
    3985 +    const fallbackState = { offsetPx: 0, laneWidthPx: groupedRouteLineWidthForCount(1), groupCount: 1 };
    3986 +    for (const kept of keptRanges) {
    3987 +      const slice = buildPolylineSlicePoints(metrics, kept.start, kept.end);
    3988 +      if (slice.length < 2) continue;
    3989 +      const mid = (kept.start + kept.end) / 2;
    3990 +      const state = laneStateAtDistance(edgeStates, metrics.cumulative, mid, fallbackState);
    3991 +      const shifted = Math.abs(Number(state?.offsetPx) || 0) > 1e-6
    3992 +        ? offsetPolylinePixels(slice, Number(state.offsetPx) || 0)
    3993 +        : slice;
    3994 +      drawCenterPolylineOnCanvas(
    3995 +        ctx,
    3996 +        shifted,
    3997 +        seg.lineColor,
    3998 +        Math.max(1, Number(state?.laneWidthPx) || fallbackState.laneWidthPx),
    3999 +      );
    4000 +    }
    4001    }
• Edited app.js (+0 -1)
    3947    const sharedLaneStateByEdgeKey = buildSharedLaneStateByEdgeKey(sharedEdges);
    3948 -  const sharedEdgeKeySet = new Set(sharedEdges.map((e) => e.key));
    3948    const segPixelPointsCache = new Map();
• Edited app.js (+23 -53)
    4611    const sharedChains = buildSharedLaneChains(sharedEdges);
    4612 -  const sharedEdgeKeySet = new Set(sharedEdges.map((e) => e.key));
    4612
         ⋮
    4702      const transitions = Array.isArray(segTransition?.transitions) ? segTransition.transitions : [];
    4704 -    const cutIntervals = transitions.map((t) => ({ start: t.startDist, end: t.endDist }));
    4705 -    const runs = buildNonSharedRunsWithIndexes(seg.points, sharedEdgeKeySet);
    4706 -    for (const run of runs) {
    4707 -      if (!metrics || !Array.isArray(metrics.cumulative) || run.endIdx >= metrics.cumulative.length) {
    4708 -        const dFallback = run.points.map(([lat, lon], i) => {
    4709 -          const [x, y] = project(lat, lon);
    4710 -          return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    4711 -        }).join(" ");
    4712 -        routePathSvg.push(`<path d="${dFallback}" fill="none" stroke="${seg.lineColor}" stroke-width="${groupedRouteLineWidthForCount(1)}" stroke-linecap="round" stroke-linejoin="round" />`);
    4713 -        continue;
    4714 -      }
    4715 -
    4716 -      const runStart = metrics.cumulative[run.startIdx];
    4717 -      const runEnd = metrics.cumulative[run.endIdx];
    4718 -      const keptRanges = subtractIntervalsFromRange(runStart, runEnd, cutIntervals);
    4719 -      for (const kept of keptRanges) {
    4720 -        const slice = buildPolylineSlicePoints(metrics, kept.start, kept.end);
    4721 -        if (slice.length < 2) continue;
    4722 -        const d = slice.map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
    4723 -        routePathSvg.push(`<path d="${d}" fill="none" stroke="${seg.lineColor}" stroke-width="${groupedRouteLineWidthForCount(1)}" stroke-linecap="round" stroke-linejoin="round" />`);
    4724 -      }
    4703 +    const edgeStates = Array.isArray(segTransition?.edgeStates) ? segTransition.edgeStates : [];
    4704 +    if (!metrics || !Array.isArray(metrics.cumulative) || !Number.isFinite(metrics.total) || metrics.total <= 0) {
    4705 +      const fallback = seg.points.map(([lat, lon], i) => {
    4706 +        const [x, y] = project(lat, lon);
    4707 +        return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    4708 +      }).join(" ");
    4709 +      routePathSvg.push(`<path d="${fallback}" fill="none" stroke="${seg.lineColor}" stroke-width="${groupedRouteLineWidthForCount(1)}" stroke-linecap="round" stroke-linejoin="round" />`);
    4710 +      continue;
    4711      }
    4726 -  }
    4712
    4728 -  const sharedLaneSvg = [];
    4729 -  for (const chain of sharedChains) {
    4730 -    if (!chain.colors || chain.colors.length <= 1 || chain.points.length < 2) continue;
    4731 -
    4732 -    const pixelPointsRaw = chain.points.map(([lat, lon]) => {
    4733 -      const [x, y] = project(lat, lon);
    4734 -      return { x, y };
    4735 -    });
    4736 -    let pixelPoints = compactPixelPolyline(pixelPointsRaw);
    4737 -    if (SIGN_ROUTE_GROUP_SIMPLIFY_TOLERANCE_PX > 0) {
    4738 -      pixelPoints = simplifyPixelPolyline(pixelPoints, SIGN_ROUTE_GROUP_SIMPLIFY_TOLERANCE_PX);
    4739 -    }
    4740 -    if (pixelPoints.length < 2) continue;
    4741 -    const groupedWidth = groupedRouteLineWidthForCount(chain.colors.length);
    4742 -    const laneStep = Math.max(2, groupedWidth / chain.colors.length);
    4743 -    const laneWidth = Math.max(2, laneStep + SIGN_ROUTE_GROUP_LANE_OVERLAP_PX);
    4744 -
    4745 -    for (let i = 0; i < chain.colors.length; i += 1) {
    4746 -      const off = ((i - ((chain.colors.length - 1) / 2)) * laneStep);
    4747 -      let shifted = offsetPolylinePixels(pixelPoints, off);
    4713 +    const cutIntervals = transitions.map((t) => ({ start: t.startDist, end: t.endDist }));
    4714 +    const keptRanges = subtractIntervalsFromRange(0, metrics.total, cutIntervals);
    4715 +    const fallbackState = { offsetPx: 0, laneWidthPx: groupedRouteLineWidthForCount(1), groupCount: 1 };
    4716 +    for (const kept of keptRanges) {
    4717 +      const slice = buildPolylineSlicePoints(metrics, kept.start, kept.end);
    4718 +      if (slice.length < 2) continue;
    4719 +      const mid = (kept.start + kept.end) / 2;
    4720 +      const state = laneStateAtDistance(edgeStates, metrics.cumulative, mid, fallbackState);
    4721 +      const shifted = Math.abs(Number(state?.offsetPx) || 0) > 1e-6
    4722 +        ? offsetPolylinePixels(slice, Number(state.offsetPx) || 0)
    4723 +        : slice;
    4724        if (shifted.length < 2) continue;
    4725        const d = shifted.map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
    4750 -      sharedLaneSvg.push(`<path d="${d}" fill="none" stroke="${chain.colors[i]}" stroke-width="${laneWidth.toFixed(2)}" stroke-linecap="butt" stroke-linejoin="round" />`);
    4751 -      const r = (laneWidth / 2).toFixed(2);
    4752 -      if (chain.roundCapStart) {
    4753 -        const s = shifted[0];
    4754 -        sharedLaneSvg.push(`<circle cx="${s.x.toFixed(2)}" cy="${s.y.toFixed(2)}" r="${r}" fill="${chain.colors[i]}" />`);
    4755 -      }
    4756 -      if (chain.roundCapEnd) {
    4757 -        const e = shifted[shifted.length - 1];
    4758 -        sharedLaneSvg.push(`<circle cx="${e.x.toFixed(2)}" cy="${e.y.toFixed(2)}" r="${r}" fill="${chain.colors[i]}" />`);
    4759 -      }
    4726 +      const w = Math.max(1, Number(state?.laneWidthPx) || fallbackState.laneWidthPx);
    4727 +      routePathSvg.push(`<path d="${d}" fill="none" stroke="${seg.lineColor}" stroke-width="${w.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" />`);
    4728      }
         ⋮
    4730
    4731 +  const sharedLaneSvg = [];
    4732 +
    4733    const transitionSvg = [];
• Explored
  └ Search buildNonSharedRunsWithIndexes\(|buildNonSharedRuns\( in app.js
• Edited app.js (+0 -66)
    2692
    2693 -function buildNonSharedRuns(points, sharedEdgeKeySet) {
    2694 -  if (!Array.isArray(points) || points.length < 2) return [];
    2695 -  if (!sharedEdgeKeySet || sharedEdgeKeySet.size === 0) return [points.slice()];
    2696 -
    2697 -  const runs = [];
    2698 -  let run = null;
    2699 -
    2700 -  for (let i = 1; i < points.length; i += 1) {
    2701 -    const a = points[i - 1];
    2702 -    const b = points[i];
    2703 -    const isShared = sharedEdgeKeySet.has(edgeKey(a, b));
    2704 -
    2705 -    if (isShared) {
    2706 -      if (run && run.length >= 2) runs.push(run);
    2707 -      run = null;
    2708 -      continue;
    2709 -    }
    2710 -
    2711 -    if (!run) run = [a, b];
    2712 -    else run.push(b);
    2713 -  }
    2714 -
    2715 -  if (run && run.length >= 2) runs.push(run);
    2716 -  return runs;
    2717 -}
    2718 -
    2719 -function buildNonSharedRunsWithIndexes(points, sharedEdgeKeySet) {
    2720 -  if (!Array.isArray(points) || points.length < 2) return [];
    2721 -  if (!sharedEdgeKeySet || sharedEdgeKeySet.size === 0) {
    2722 -    return [{ startIdx: 0, endIdx: points.length - 1, points: points.slice() }];
    2723 -  }
    2724 -
    2725 -  const runs = [];
    2726 -  let runStartIdx = -1;
    2727 -
    2728 -  for (let i = 1; i < points.length; i += 1) {
    2729 -    const a = points[i - 1];
    2730 -    const b = points[i];
    2731 -    const isShared = sharedEdgeKeySet.has(edgeKey(a, b));
    2732 -
    2733 -    if (isShared) {
    2734 -      if (runStartIdx >= 0 && (i - 1) - runStartIdx >= 1) {
    2735 -        runs.push({
    2736 -          startIdx: runStartIdx,
    2737 -          endIdx: i - 1,
    2738 -          points: points.slice(runStartIdx, i),
    2739 -        });
    2740 -      }
    2741 -      runStartIdx = -1;
    2742 -      continue;
    2743 -    }
    2744 -
    2745 -    if (runStartIdx < 0) runStartIdx = i - 1;
    2746 -  }
    2747 -
    2748 -  if (runStartIdx >= 0 && (points.length - 1) - runStartIdx >= 1) {
    2749 -    runs.push({
    2750 -      startIdx: runStartIdx,
    2751 -      endIdx: points.length - 1,
    2752 -      points: points.slice(runStartIdx),
    2753 -    });
    2754 -  }
    2755 -
    2756 -  return runs;
    2757 -}
    2758 -
    2693  function subtractIntervalsFromRange(start, end, intervals) {
• Ran node --check app.js
  └ (no output)
• Explored
  └ Search drawStripedPolylineOnCanvas\( in app.js
    Search sharedEdgeKeySet in app.js
    Search SIGN_ROUTE_SPLIT_MERGE_TRANSITION_PX|subtractIntervalsFromRange|laneStateAtDistance|buildSegmentLaneTransitions\(|startDist = vertexDist;|startDist = Math.max\(0, vertexDist - transitionPx\)|keptRanges
=
           subtractIntervalsFromRange\(0, metrics.total in app.js
    Search drawTransitionSamplesOnCanvas|buildTransitionSamplesSvg|transitionSvg.push in app.js
─ Worked for 1m 49s ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
• Updated the rendering algorithm so continuation is now deferred until the transition window is finished.

  - Transition windows are still computed the same way:
      - split: starts at boundary, ends +SIGN_ROUTE_SPLIT_MERGE_TRANSITION_PX
      - merge: starts -SIGN_ROUTE_SPLIT_MERGE_TRANSITION_PX, ends at boundary
        (app.js:3080, app.js:3120, app.js:3124)
  - Base line rendering now excludes those transition intervals entirely, then only draws the continuation outside them (using lane state at that segment distance).
    (app.js:2693, app.js:3066, app.js:3917, app.js:3923, app.js:4648, app.js:4654)
  - Transition strokes are then drawn inside the excluded interval, so with 20px the continuation starts after those 20px.
    (app.js:3942, app.js:4674)
  - Applied to both preview canvas and SVG export, so they match.

  Validation: node --check app.js passed.

 -->