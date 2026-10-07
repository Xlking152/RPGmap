// Derived Canvas boundaries use shared row intersections for the facade and
// foreign shadows. The renderer never invokes a polygon boolean library.
function facadeRowOutlines(polygons, shadows, indices, bounds) {
  const [originX,originY,maxX,maxY]=bounds,width=maxX-originX,height=maxY-originY;
  const allEdges=[], ys=new Set([0,height]);
  const prepare=rings=>{
    const edges=[];
    for(const ring of rings)for(let i=0;i<ring.length;i++){
      const a=ring[i],b=ring[(i+1)%ring.length];
      if(a[1]===b[1])continue;
      const low=Math.min(a[1],b[1])-originY,high=Math.max(a[1],b[1])-originY;
      if(high<=0||low>=height)continue;
      const slope=(b[0]-a[0])/(b[1]-a[1]);
      const edge={x:a[0]-originX+(originY-a[1])*slope,slope,low,high,id:allEdges.length};
      const firstX=edge.x+Math.max(0,low)*slope,lastX=edge.x+Math.min(height,high)*slope;
      edge.minX=Math.min(firstX,lastX);edge.maxX=Math.max(firstX,lastX);
      edges.push(edge);allEdges.push(edge);
      if(low>0&&low<height)ys.add(low);
      if(high>0&&high<height)ys.add(high);
    }
    return edges;
  };
  const facades=polygons.map(prepare),occlusion=indices.map(index=>prepare(shadows[index]||[]));
  // Only pairs whose clipped segment bounds overlap can change row order
  // inside the facade. Sweep these bounds, rather than all scene edges.
  const crossing=allEdges.filter(edge=>edge.maxX>=0&&edge.minX<=width).sort((a,b)=>a.minX-b.minX||a.id-b.id);
  for(let i=0;i<crossing.length;i++)for(let j=i+1;j<crossing.length;j++){
    const a=crossing[i],b=crossing[j];
    if(b.minX>Math.min(a.maxX,width))break;
    if(Math.max(a.low,b.low,0)>=Math.min(a.high,b.high,height))continue;
    const denominator=a.slope-b.slope;
    if(!denominator)continue;
    const y=(b.x-a.x)/denominator;
    if(y<=0||y>=height||y<=Math.max(a.low,b.low)||y>=Math.min(a.high,b.high))continue;
    // Pair bounds already restrict candidates to the facade. A boundary
    // intersection may evaluate its x a few ulps outside 0/width; dropping
    // that event would extend the wrong interval through the next band.
    ys.add(y);
  }
  const xAt=(edge,y)=>edge.x+y*edge.slope;
  const intervals=(sets,y)=>{
    const spans=[];
    for(const edges of sets){
      const active=edges.filter(edge=>edge.low<y&&edge.high>y)
        .sort((a,b)=>xAt(a,y)-xAt(b,y)||a.id-b.id);
      for(let i=0;i+1<active.length;i+=2)spans.push([active[i],active[i+1]]);
    }
    spans.sort((a,b)=>xAt(a[0],y)-xAt(b[0],y)||xAt(a[1],y)-xAt(b[1],y));
    const merged=[];
    for(const span of spans){
      const last=merged.at(-1);
      if(!last||xAt(last[1],y)<xAt(span[0],y))merged.push([...span]);
      else if(xAt(span[1],y)>xAt(last[1],y))last[1]=span[1];
    }
    return merged;
  };
  const rows=[...ys].sort((a,b)=>a-b),path=[];
  const add=(left,right,top,bottom)=>{
    if(xAt(right,(top+bottom)/2)<=xAt(left,(top+bottom)/2))return;
    path.push([[xAt(left,top),top],[xAt(right,top),top],
      [xAt(right,bottom),bottom],[xAt(left,bottom),bottom]]);
  };
  for(let row=1;row<rows.length;row++){
    const top=rows[row-1],bottom=rows[row],middle=top+(bottom-top)/2;
    const visible=intervals(facades,middle),hidden=intervals(occlusion,middle);
    for(const [begin,end]of visible){
      let left=begin;
      for(const [start,finish]of hidden){
        if(xAt(start,middle)>=xAt(end,middle))break;
        if(xAt(finish,middle)<=xAt(left,middle))continue;
        if(xAt(start,middle)>xAt(left,middle))add(left,start,top,bottom);
        if(xAt(finish,middle)>xAt(left,middle))left=finish;
        if(xAt(left,middle)>=xAt(end,middle))break;
      }
      if(xAt(left,middle)<xAt(end,middle))add(left,end,top,bottom);
    }
  }
  // Cancel common cross-section edges before sending the path to Canvas.
  // Splitting an otherwise straight exterior edge at each band can alter
  // Canvas's eight-bit antialias rounding, despite identical filled geometry.
  const rowsByY=new Map(),edges=[];
  const horizontal=(y,x0,x1,sign)=>{
    const events=rowsByY.get(y)||[];events.push([x0,sign],[x1,-sign]);rowsByY.set(y,events);
  };
  for(const ring of path){
    horizontal(ring[0][1],ring[0][0],ring[1][0],1);
    horizontal(ring[2][1],ring[3][0],ring[2][0],-1);
    if(ring[1][0]!==ring[2][0]||ring[1][1]!==ring[2][1])edges.push([ring[1],ring[2]]);
    if(ring[3][0]!==ring[0][0]||ring[3][1]!==ring[0][1])edges.push([ring[3],ring[0]]);
  }
  for(const [y,events]of rowsByY){
    events.sort((a,b)=>a[0]-b[0]);let count=0,start=null;
    for(let i=0;i<events.length;){
      const x=events[i][0];let delta=0;
      while(i<events.length&&events[i][0]===x)delta+=events[i++][1];
      const next=count+delta;
      if(count&&(!next||Math.sign(count)!==Math.sign(next))){
        if(start<x)edges.push(count>0?[[start,y],[x,y]]:[[x,y],[start,y]]);start=null;
      }
      if(next&&(!count||Math.sign(count)!==Math.sign(next)))start=x;
      count=next;
    }
  }
  const tolerance=Math.max(1,width,height)*Number.EPSILON*128;
  const key=point=>`${Math.round(point[0]/tolerance)}:${Math.round(point[1]/tolerance)}`;
  const outgoing=new Map();
  for(const edge of edges){
    edge.start=key(edge[0]);edge.end=key(edge[1]);edge.used=false;
    if(edge.start===edge.end){edge.used=true;continue;}
    const list=outgoing.get(edge.start)||[];list.push(edge);outgoing.set(edge.start,list);
  }
  const rings=[];
  for(const first of edges){
    if(first.used)continue;
    const ring=[];let edge=first,closed=false;
    for(let step=0;step<=edges.length;step++){
      edge.used=true;ring.push(edge[0]);if(edge.end===first.start){closed=true;break;}
      const choices=(outgoing.get(edge.end)||[]).filter(candidate=>!candidate.used);
      if(!choices.length)break;
      const dx=edge[1][0]-edge[0][0],dy=edge[1][1]-edge[0][1];
      const turn=candidate=>{const ex=candidate[1][0]-candidate[0][0],ey=candidate[1][1]-candidate[0][1];
        return Math.atan2(dx*ey-dy*ex,dx*ex+dy*ey);};
      choices.sort((a,b)=>turn(b)-turn(a));edge=choices[0];
    }
    if(!closed)throw new Error('Facade row boundary is not closed');
    // The two edges meeting at an intersection can evaluate its coordinate a
    // few ulps apart. Remove that duplicate before simplifying collinear
    // vertices, or both copies of a genuine corner could be removed together.
    const vertices=[];
    for(const point of ring){
      const last=vertices.at(-1);
      if(!last||Math.hypot(point[0]-last[0],point[1]-last[1])>tolerance*2)vertices.push(point);
    }
    if(vertices.length>1&&Math.hypot(vertices[0][0]-vertices.at(-1)[0],vertices[0][1]-vertices.at(-1)[1])<=tolerance*2)vertices.pop();
    const simplified=vertices.filter((b,i)=>{
      const a=vertices[(i+vertices.length-1)%vertices.length],c=vertices[(i+1)%vertices.length];
      const dx=b[0]-a[0],dy=b[1]-a[1],ex=c[0]-b[0],ey=c[1]-b[1];
      return Math.abs(dx*ey-dy*ex)>tolerance*(Math.hypot(dx,dy)+Math.hypot(ex,ey))||dx*ex+dy*ey<0;
    });
    if(simplified.length>=3){
      let start=0;
      for(let i=1;i<simplified.length;i++)if(simplified[i][0]<simplified[start][0]
        ||simplified[i][0]===simplified[start][0]&&simplified[i][1]<simplified[start][1])start=i;
      rings.push([...simplified.slice(start),...simplified.slice(0,start)]);
    }
  }
  return rings;
}

function facadeRowMaskGroups(rings) {
  const outers=[],holes=[];
  for(const ring of rings){
    const [x,y]=ring[0];const area=ring.reduce((sum,a,i)=>{
      const b=ring[(i+1)%ring.length];return sum+(a[0]-x)*(b[1]-y)-(b[0]-x)*(a[1]-y);
    },0);
    if(area>0)outers.push({ring,area,holes:[]});else if(area<0)holes.push(ring);
  }
  const contains=(ring,[x,y])=>{
    let inside=false;
    for(let i=0,j=ring.length-1;i<ring.length;j=i++){
      const a=ring[i],b=ring[j];
      if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])inside=!inside;
    }
    return inside;
  };
  for(const hole of holes){
    const outer=outers.filter(value=>contains(value.ring,hole[0])).sort((a,b)=>a.area-b.area)[0];
    if(!outer)throw new Error('Facade row hole has no enclosing outer boundary');
    outer.holes.push(hole);
  }
  return outers.map(value=>[value.ring,...value.holes]);
}

/** Pure presentation mask; its boundaries never alter authoritative visibility. */
export function facadeMaskPolygons(polygons, shadows, indices) {
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  for(const rings of polygons)for(const ring of rings)for(const [x,y]of ring){
    left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);
  }
  if(!(left<right&&top<bottom))return [];
  const relevant=indices.filter(index=>{
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for(const ring of shadows[index]||[])for(const [x,y]of ring){
      x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);
    }
    return x0<=right&&x1>=left&&y0<=bottom&&y1>=top;
  });
  if(!relevant.length)return polygons;
  const groups=facadeRowMaskGroups(facadeRowOutlines(polygons,shadows,relevant,[left,top,right,bottom]));
  return groups.map(rings=>rings.map(ring=>ring.map(([x,y])=>[x+left,y+top])));
}
