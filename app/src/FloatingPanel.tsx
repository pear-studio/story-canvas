import { useImperativeHandle, useMemo, useRef, type HTMLAttributes, type Ref } from "react";
import { useFloatingLayer, type FloatingTarget } from "./floating-layer";

/** 供已有候选定位器使用；保留其宽高建议，统一顶层与最终边界约束。 */
export function FloatingPanel({ ref, target, ...props }: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement>; target?: FloatingTarget }) {
  const node = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => node.current!);
  const point = useMemo(() => target ?? { x: Number(props.style?.left ?? 8), y: Number(props.style?.top ?? 8), above: props.style?.transform === "translateY(-100%)" }, [target, props.style?.left, props.style?.top, props.style?.transform]);
  useFloatingLayer(node, point);
  return <div {...props} ref={node} />;
}
