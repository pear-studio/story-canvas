import { useEffect, useState } from "react";

// 目录抽屉的判定：视口不超过 1160px（含窄桌面窗口与手机请求桌面版的
// ~980px 视口）时目录收进抽屉，由顶栏按钮打开；编辑与生成能力保持完整。
export const NAVIGATION_DRAWER_MEDIA_QUERY = "(max-width: 1160px)";

export function useNavigationDrawer() {
  const [drawer, setDrawer] = useState(() => typeof window !== "undefined" && window.matchMedia(NAVIGATION_DRAWER_MEDIA_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(NAVIGATION_DRAWER_MEDIA_QUERY);
    const change = () => setDrawer(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return drawer;
}
