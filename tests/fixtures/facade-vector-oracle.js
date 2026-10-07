import polygonClipping from 'polygon-clipping';

// QA-only world-coordinate reference. Production rendering never calls these
// boolean operations, and the failing Sweep operands use a separate point/ray
// oracle. These small, ordinary fixtures establish the final visible boundary
// rather than treating a buried shadow edge as an exposed boundary.
export const ORACLE_CIRCLE_SEGMENTS = 2048;
const close = polygons => polygons.map(rings => rings.map(ring => {
  const first = ring[0], last = ring.at(-1);
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
}));
const circle = (x,y,radius) => {
  const ring = Array.from({length:ORACLE_CIRCLE_SEGMENTS},(_,index) => {
    const angle = index*Math.PI*2/ORACLE_CIRCLE_SEGMENTS;
    return [x+radius*Math.cos(angle),y+radius*Math.sin(angle)];
  });
  return [[ [...ring,ring[0]] ]];
};
const union = (left,right) => !left.length ? right : !right.length ? left : polygonClipping.union(left,right);
const difference = (left,right) => !left.length || !right.length ? left : polygonClipping.difference(left,right);
const intersection = (left,right) => !left.length || !right.length ? [] : polygonClipping.intersection(left,right);

export function referenceVisibleRegions(projection,source,radiusUnits,mode,regions,viewport={}) {
  if (projection.blocked) return [];
  const {center=[0,0],scale=1,width=0,height=0,dpr=1} = viewport;
  const project = polygons => polygons.map(rings=>rings.map(ring=>ring.map(([x,y])=>[
    center[0]+x*scale,center[1]+y*scale,
  ])));
  const ratioX = width ? width*dpr/Math.ceil(width*dpr) : 1;
  const ratioY = height ? height*dpr/Math.ceil(height*dpr) : 1;
  const copy = (polygons,times) => polygons.map(rings=>rings.map(ring=>ring.map(([x,y])=>[
    x*ratioX**times,y*ratioY**times,
  ])));
  const sight = circle(source.x,source.y,radiusUnits);
  const base = difference(sight,close(projection.shadows));
  const facades = close(projection.facades.flatMap(facade=>facade.polygons));
  const visible = project(intersection(sight,union(base,facades)));
  // Each drawImage(source,0,0,width,height) maps the rounded backing size back
  // to its logical size. The reference has two final copies, plus two light
  // copies; its dark-and-normal tint has one additional geometry/light copy.
  // Modeling these separately avoids treating a buried lighting edge as a
  // final boundary or shifting every layer by an arbitrary uniform factor.
  if (mode === 'all') return copy(visible,2);
  const lighting = normal => {
    let result = [];
    for (const region of regions) {
      const radius = normal ? region.normalRadiusUnits : region.radiusUnits;
      if (region.blocked || radius <= 0) continue;
      result = union(result,difference(circle(region.x,region.y,radius),close(region.shadows || [])));
    }
    return project(result);
  };
  if (mode !== 'dark-and-normal') return intersection(copy(visible,2),copy(lighting(mode==='normal'),4));
  return union(difference(copy(visible,2),copy(lighting(false),4)),
    intersection(copy(visible,3),copy(lighting(true),5)));
}

// Self-contained so the exact same function can inspect real Chrome output.
// Polygons are already in CSS coordinates and model the complete copy chain.
// Distances never come from the nearest differently colored raster neighbor.
export function vectorBoundaryDistanceCss(polygons,x,y) {
  let distance = Infinity;
  for (const rings of polygons) for (const ring of rings) for (let i=0;i<ring.length;i++) {
    const a = ring[i], b = ring[(i+1)%ring.length];
    const ax = a[0], ay = a[1], bx = b[0], by = b[1];
    const dx = bx-ax, dy = by-ay, lengthSquared = dx*dx+dy*dy;
    if (!lengthSquared) continue;
    const t = Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/lengthSquared));
    distance = Math.min(distance,Math.hypot(x-ax-t*dx,y-ay-t*dy));
  }
  return distance;
}

// A regular inscribed circle differs from its exact arc by at most this much.
// Add the bound to measured distances, so approximation can only make the
// one-CSS-pixel gate stricter, never admit a point farther than one pixel.
export function circleChordErrorCss(radiusUnits,scale) {
  return Math.abs(radiusUnits*scale)*(1-Math.cos(Math.PI/ORACLE_CIRCLE_SEGMENTS));
}

// Canvas source-over/source-out compositing can retain antialias opacity seams
// even when a binary visible-set union buries the operand edge. These edges
// only qualify reference pixels whose measured alpha is partial; opaque/black
// pixels always use the final visible-set boundary above.
export function referenceOpacityEdges(projection,source,radiusUnits,mode,regions,viewport={}) {
  const {center=[0,0],scale=1,width=0,height=0,dpr=1}=viewport;
  const qx=width?width*dpr/Math.ceil(width*dpr):1,qy=height?height*dpr/Math.ceil(height*dpr):1;
  const copies=(polygons,times)=>polygons.map(rings=>rings.map(ring=>ring.map(([x,y])=>[
    (center[0]+x*scale)*qx**times,(center[1]+y*scale)*qy**times,
  ])));
  const base=[...circle(source.x,source.y,radiusUnits),...projection.shadows,...projection.facades.flatMap(value=>value.polygons)];
  const edges=copies(base,2);
  if(mode==='all')return edges;
  if(mode==='dark-and-normal')edges.push(...copies(base,3));
  for(const region of regions) {
    if(region.blocked)continue;
    for(const normal of mode==='dark-and-normal'?[false,true]:[mode==='normal']) {
      const radius=normal?region.normalRadiusUnits:region.radiusUnits;
      if(radius<=0)continue;
      const times=mode==='dark-and-normal'&&normal?5:4;
      edges.push(...copies([...circle(region.x,region.y,radius),...(region.shadows||[])],times));
    }
  }
  return edges;
}
