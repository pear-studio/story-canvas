import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { useTooltips } from "../../../src/use-tooltips";
import { NavigationContextMenu } from "../../../src/NavigationContextMenu";
import { Popover } from "../../../src/Popover";
import "../../../src/styles.css";
function Fixture() {
  useTooltips();
  const [point, setPoint] = useState<{x:number;y:number}|null>(null);
  return <>
    <div style={{position:"fixed",bottom:8,right:8,width:100,height:60,overflow:"hidden",transform:"translateZ(0)"}}>
      <button data-tooltip={"提示跨越裁切容器。".repeat(12)}>提示</button>
      <Popover className="project-switcher"><summary>菜单</summary><div className="project-switcher-menu"><button>菜单内容</button></div></Popover>
    </div>
    <button onClick={()=>setPoint({x:innerWidth-2,y:innerHeight-2})}>右键菜单</button>
    <button onClick={()=>document.querySelector("dialog")!.showModal()}>打开弹窗</button>
    <dialog><button data-tooltip="弹窗内的完整提示">弹窗提示</button><button onClick={()=>setPoint({x:innerWidth-2,y:innerHeight-2})}>弹窗菜单</button></dialog>
    <NavigationContextMenu request={point ? {...point,label:"测试菜单",items:Array.from({length:30},(_,i)=>({id:String(i),label:`操作 ${i}`,onSelect:()=>{}}))}:null} onClose={()=>setPoint(null)} />
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
