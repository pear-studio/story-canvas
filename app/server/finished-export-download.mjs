import {createReadStream,createWriteStream} from 'node:fs';
import {readFile,rename,unlink} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import yazl from 'yazl';
import {finishedReaderHead,finishedReaderFigure,finishedReaderAnimation,finishedReaderTail} from '../shared/finished-reader.mjs';

// HTTP 下载与本机批量落盘共用流式写出，不将整包装进内存。
export function createFinishedExportStream({files,preview,title,locale}) {
  if(preview){
    const head=finishedReaderHead(title,locale);
    const figure=(file,base64='')=>file.media_kind==='video'
      ?finishedReaderAnimation('data:video/mp4;base64,'+base64,file.index+1,file.width,file.height)
      :finishedReaderFigure('data:image/webp;base64,'+base64,file.index+1,file.width,file.height);
    const size=Buffer.byteLength(head)+Buffer.byteLength(finishedReaderTail)+files.reduce((s,f)=>s+Buffer.byteLength(figure(f))+4*Math.ceil(f.size/3),0);
    async function* chunks(){yield head;for(const file of files)yield figure(file,(await readFile(file.target)).toString('base64'));yield finishedReaderTail;}
    const stream=Readable.from(chunks());
    return {stream,size,contentType:'text/html; charset=utf-8',dispose:()=>stream.destroy()};
  }
  const zip=new yazl.ZipFile();let source,size;
  zip.on('error',error=>zip.outputStream.destroy(error));
  for(const file of files)zip.addReadStreamLazy(file.name,{compress:false,size:file.size},callback=>{
    source=createReadStream(file.target);source.on('error',error=>zip.emit('error',error));callback(null,source);
  });
  zip.end(total=>{size=total;});
  return {stream:zip.outputStream,size,contentType:'application/zip',dispose:()=>{zip.errored=true;source?.destroy();zip.outputStream.destroy();}};
}
export async function sendFinishedExport(response,prepared) {
  const output=createFinishedExportStream(prepared);
  response.writeHead(200,{'content-type':output.contentType,'content-disposition':prepared.disposition,'cache-control':'no-store','content-length':String(output.size)});
  response.once('close',output.dispose);
  try {await pipeline(output.stream,response);}
  catch(error){if(error.code!=='ERR_STREAM_PREMATURE_CLOSE')throw error;}
  finally {response.off('close',output.dispose);output.dispose();}
}
export async function writeFinishedExport(target,prepared,signal,maxBytes=Infinity) {
  const output=createFinishedExportStream(prepared),temporary=target+'.partial';
  if(output.size>maxBytes){output.dispose();throw Error('导出包超过大小限制');}
  try {await pipeline(output.stream,createWriteStream(temporary,{flags:'wx'}),{signal});signal.throwIfAborted();await rename(temporary,target);return output.size;}
  finally {output.dispose();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
