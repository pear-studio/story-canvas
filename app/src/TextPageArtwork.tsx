import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { letteringTypographyVariables, type LetteringStyle } from "./lettering";
import { defaultTextPageLayout, type TextPageLayout } from "../shared/text-page-layout.mjs";
import type {LetteringLocale} from './page-translations';

/** 预览和成品共用：按整组中心定位，长文向画布内收，溢出交给编辑器或输出入口提示。 */
export function TextPageArtwork({ title, body = "", style, layout = defaultTextPageLayout, onOverflow,locale='zh' }: {
  locale?:LetteringLocale;
  title: string;
  body?: string;
  style: Pick<LetteringStyle, "font_family">;
  layout?: TextPageLayout;
  onOverflow?: (overflow: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [fontScale,setFontScale]=useState(1);
  useLayoutEffect(() => {
    const frame = host.current!, text = content.current!;
    const measure = () => {
      const height = frame.clientHeight;
      const contentHeight = text.getBoundingClientRect().height;
      if(locale!=='zh'&&contentHeight>height*.84+1&&fontScale>.85){setFontScale(Math.max(.85,fontScale-.05));return;}
      const margin = height * .08;
      const fraction = layout.position === "upper" ? 1 / 3 : layout.position === "lower" ? 2 / 3 : .5;
      const top = Math.max(margin, Math.min(height * fraction - contentHeight / 2, height - margin - contentHeight));
      text.style.top = `${top}px`;
      const clipped = contentHeight > height - 2 * margin + 1 || text.scrollWidth > text.clientWidth + 1;
      setOverflow(clipped);
      onOverflow?.(clipped);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame); observer.observe(text);
    return () => observer.disconnect();
  }, [title, body, layout, style.font_family, onOverflow,locale,fontScale]);
  useLayoutEffect(()=>{setFontScale(1);void document.fonts.load(`28px "${style.font_family}"`,title+body).then(()=>setFontScale(value=>value));},[title,body,locale,style.font_family]);
  return <div ref={host} lang={locale} className="text-page-artwork" data-overflow={overflow} style={{
    ...letteringTypographyVariables({ ...style, font_size: layout.body_font_size }, "canvas"),
    "--text-title-size": `${layout.title_font_size*fontScale / 10.24}cqw`,
    "--text-body-size": `${layout.body_font_size*fontScale / 10.24}cqw`,
  } as CSSProperties}>
    <div ref={content} className="text-page-artwork__content">
      {title.trim() && <h1 className="text-page-artwork__title" style={{ textAlign: layout.title_align }}>{title}</h1>}
      {body.trim() && <p className="text-page-artwork__body" style={{ textAlign: layout.body_align }}>{body}</p>}
    </div>
  </div>;
}
