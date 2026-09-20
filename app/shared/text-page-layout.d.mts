export type TextPageAlignment = "left" | "center" | "right";
export type TextPageLayout = {
  title_font_size: number;
  body_font_size: number;
  title_align: TextPageAlignment;
  body_align: TextPageAlignment;
  position: "upper" | "center" | "lower";
};
export const defaultTextPageLayout: Readonly<TextPageLayout>;
