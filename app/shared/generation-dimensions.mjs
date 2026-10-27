export function generationDimensions(resolutions,canvas,scale=1) {
  const size=resolutions?.[canvas];
  if(!size)return null;
  if(scale===1)return {width:size.width,height:size.height};
  return {width:Math.round(size.width*scale/16)*16,height:Math.round(size.height*scale/16)*16};
}
