export type ComicNode = {page_id:string} | {id:string;axis:'x'|'y';ratio:number;first:ComicNode;second:ComicNode};
export type ComicPanel = {candidate_id:string|null;crop:{x:number;y:number;zoom:number};size_mode:'panel'|'preset'};
export type ComicDocument = {version:1;canvas:string;margin:number;gutter:number;layout:ComicNode;order:string[];panels:Record<string,ComicPanel>};
export type ComicBox = {x:number;y:number;w:number;h:number};
export function comicLeaves(node:ComicNode):string[];
export function validateComicDocument(value:unknown,pageId:string):string[];
export function comicGeometry(document:ComicDocument):{width:number;height:number;frames:Record<string,ComicBox>;dividers:Array<{id:string;axis:'x'|'y';ratio:number;box:ComicBox;position:number}>};
export function updateComicNode(node:ComicNode,id:string,update:(node:ComicNode)=>ComicNode):ComicNode;
export function comicPanelDimensions(document:ComicDocument,pageId:string):{width:number;height:number};
