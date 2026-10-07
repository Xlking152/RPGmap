import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { facadeMaskPolygons } from '../src/vision/facade-mask.js';

const rect=(x,y,width,height)=>[[x,y],[x+width,y],[x+width,y+height],[x,y+height]];
const area=polygons=>polygons.reduce((total,rings)=>total+rings.reduce((sum,ring,index)=>{
  const [x,y]=ring[0];const value=Math.abs(ring.reduce((sum,a,i)=>{
    const b=ring[(i+1)%ring.length];return sum+(a[0]-x)*(b[1]-y)-(b[0]-x)*(a[1]-y);
  },0))/2;return sum+(index===0?value:-value);
},0),0);
const insideRing=(ring,x,y)=>{
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const a=ring[i],b=ring[j];
    if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside;
};
const insidePolygon=(rings,x,y)=>rings.reduce((inside,ring)=>inside!==insideRing(ring,x,y),false);
const insideUnion=(polygons,x,y)=>polygons.some(rings=>insidePolygon(rings,x,y));

test('shared boundaries preserve facade holes and crossing shadows without mutating inputs',()=>{
  const facades=[[rect(0,0,10,10),rect(3,3,4,4)]],shadows=[[rect(3,-5,4,20)]];
  const snapshot=structuredClone({facades,shadows});
  const path=facadeMaskPolygons(facades,shadows,[0]);
  assert.equal(area(path),60);
  for(let row=0;row<40;row++)for(let column=0;column<40;column++){
    const x=column*.25+.13,y=row*.25+.11;
    assert.equal(insideUnion(path,x,y),insideUnion(facades,x,y)&&!insideUnion(shadows,x,y));
  }
  assert.deepEqual({facades,shadows},snapshot);
});

test('overlapping shadows form a union while their transparent holes remain visible',()=>{
  const facades=[[rect(0,0,10,10)]];
  const shadows=[[rect(2,2,6,6),rect(4,4,2,2)],[rect(5,0,4,10)]];
  assert.equal(area(facadeMaskPolygons(facades,shadows,[0,1])),44);
  assert.equal(area(facadeMaskPolygons(facades,shadows,[1,0])),44);
});

test('intersecting slanted edges change interval order at their exact crossing',()=>{
  const facades=[[rect(0,0,10,10)]];
  const shadows=[[[[0,0],[10,0],[0,10]]],[[[10,0],[10,10],[0,10]]]];
  assert.equal(area(facadeMaskPolygons(facades,shadows,[0,1])),0);
  assert.equal(area(facadeMaskPolygons(facades,[shadows[0]],[0])),50);
});

test('shared cross sections cancel and exterior collinear vertices retain the original Canvas path',()=>{
  const facades=[[rect(8,-5,3,10)]],shadows=[[[[4,1],[4,-1],[38,-9.5],[38,9.5]]]];
  assert.deepEqual(facadeMaskPolygons(facades,shadows,[0]),[
    [[[8,-5],[11,-5],[11,-2.75],[8,-2]]],
    [[[8,2],[11,2.75],[11,5],[8,5]]],
  ]);
});

test('connected components retain their own holes and independent compositing',()=>{
  const facades=[[rect(0,0,10,10),rect(3,3,4,4)],[rect(20,0,10,10),rect(22,2,2,2)]];
  const shadows=[[rect(-1,8,40,1)]];
  const groups=facadeMaskPolygons(facades,shadows,[0]);
  assert.equal(groups.length,4);
  assert.equal(groups.filter(group=>group.length===2).length,2);
  for(const [x,y]of [[1,1],[4,4],[9,9],[21,1],[23,3],[28,8.5],[15,5]]){
    assert.equal(insideUnion(groups,x,y),insideUnion(facades,x,y)&&!insideUnion(shadows,x,y));
  }
});

test('tangent and out-of-bounds shadows cannot remove facade interiors',()=>{
  const facades=[[rect(0,0,10,10)]];
  const shadows=[[rect(10,0,10,10)],[rect(1000,-1,100,100)]];
  assert.deepEqual(facadeMaskPolygons(facades,shadows,[1]),facades);
  assert.equal(area(facadeMaskPolygons(facades,shadows,[0,1])),100);
});

test('large coordinate origins retain small holes and their shared intersections',()=>{
  const facades=[[rect(0,0,8,8),rect(2,2,2,2)]],shadows=[[rect(6,-1,4,10)]];
  const expected=facadeMaskPolygons(facades,shadows,[0]);
  for(const origin of [1e9,1e12]){
    const shift=polygons=>polygons.map(rings=>rings.map(ring=>ring.map(([x,y])=>[x+origin,y+origin])));
    const translatedFacades=shift(facades),translatedShadows=shift(shadows);
    const snapshot=structuredClone({translatedFacades,translatedShadows});
    const actual=facadeMaskPolygons(translatedFacades,translatedShadows,[0]);
    assert.deepEqual(actual.map(rings=>rings.map(ring=>ring.map(([x,y])=>[x-origin,y-origin]))),expected);
    assert.deepEqual({translatedFacades,translatedShadows},snapshot);
  }
});

test('ulp-separated copies of a shadow crossing retain the real corner before collinear cleanup',()=>{
  const facades=[[rect(0,0,10,10),rect(3,3,2,2)]];
  const shadows=[
    [[[-0.11266011074474847,3.9691097228623233],[1.4292320964790486,6.432006437183569],[-4.732023685422625,10.289249910523813],[-6.273915892646422,7.826353196202567]]],
    [[[-0.03872860386492194,4.980465451208412],[3.455325694562276,7.9391982702364094],[0.29186093970657767,11.675026511820496],[-3.20219335872062,8.716293692792497]]],
    [[[15.633745168725753,7.184350617423698],[12.236206382135311,10.186225430841814],[9.083032439072824,6.617445438906505],[12.480571225663265,3.615570625488388]]],
  ];
  const path=facadeMaskPolygons(facades,shadows,[0,1,2]);
  assert.equal(insideUnion(path,.636188997887075,4.852387711871415),true);
  for(let row=0;row<40;row++)for(let column=0;column<40;column++){
    const x=column*.25+.13,y=row*.25+.11;
    assert.equal(insideUnion(path,x,y),insideUnion(facades,x,y)&&!insideUnion(shadows,x,y));
  }
});

test('ulp-separated intersections on the facade boundary cannot remove a corner and leak light',()=>{
  const facades=[[rect(0,0,10,10),rect(3,3,2,2)]];
  const shadows=[
    [[[-2.914447223040219,3.44127347024554],[5.7393171180916775,5.929651412529238],[3.0343229642314276,15.336736065499245],[-5.619441376900469,12.848358123215547]]],
    [[[8.992010124715382,10.448194441335389],[5.575492185039,9.969890315685241],[6.75788450731117,1.5240827966983232],[10.174402446987553,2.002386922348471]]],
  ];
  const path=facadeMaskPolygons(facades,shadows,[0,1]);
  assert.equal(insideUnion(path,.5915935127995908,4.552572467364371),false);
});

test('rotated overlapping shadows preserve independent ray results across deterministic fixtures',()=>{
  let seed=17321;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  const facades=[[rect(0,0,10,10),rect(3,3,2,2)]];
  for(let fixture=0;fixture<150;fixture++){
    const shadows=Array.from({length:4},()=>{
      const x=random()*16-3,y=random()*16-3,width=random()*8+.5,height=random()*8+.5;
      const angle=random()*Math.PI,c=Math.cos(angle),s=Math.sin(angle);
      return [rect(-width/2,-height/2,width,height).map(([a,b])=>[x+a*c-b*s,y+a*s+b*c])];
    });
    const path=facadeMaskPolygons(facades,shadows,[0,1,2,3]);
    for(let point=0;point<100;point++){
      const x=random()*10,y=random()*10;
      assert.equal(insideUnion(path,x,y),insideUnion(facades,x,y)&&!insideUnion(shadows,x,y),`fixture ${fixture} point ${x},${y}`);
    }
  }
});

test('SweepEvent operands agree with independent point rays and preserve their immutable geometry',async()=>{
  const regression=JSON.parse(await readFile(new URL('./fixtures/vision-facade-sweep-regression.json',import.meta.url),'utf8'));
  const facades=regression.facade.polygons,shadows=regression.shadows;
  const snapshot=structuredClone({facades,shadows});
  const path=facadeMaskPolygons(facades,shadows,shadows.map((_,index)=>index));
  const points=facades.flat(2),xs=points.map(point=>point[0]),ys=points.map(point=>point[1]);
  const x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
  for(let row=0;row<60;row++)for(let column=0;column<60;column++){
    const x=x0+(column+.371)/60*(x1-x0),y=y0+(row+.619)/60*(y1-y0);
    assert.equal(insideUnion(path,x,y),insideUnion(facades,x,y)&&!insideUnion(shadows,x,y),`point ${x},${y}`);
  }
  assert.deepEqual({facades,shadows},snapshot);
});
