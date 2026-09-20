import { useState } from "react";
import { CAMERA_DEFAULTS, CAMERA_DIRECTIONS, CAMERA_HEIGHTS, CAMERA_SHOTS, CAMERA_VIEWS, CAMERA_BODY, CAMERA_EFFECTS, changeCameraPerspective, changeCameraView, createCameraFragment, parseCameraSettings, type CameraSettings } from "../shared/camera-prompt.mjs";
import { Modal } from "./Modal";
import "./CameraControlDialog.css";

const directionWords = { front: "from front", side: "from side", back: "from behind" } as const;
const heightWords = { above: "from above", below: "from below" } as const;

export function CameraControlDialog({ cameraSettings, onClose, onApply }: { cameraSettings?: CameraSettings; onClose: () => void; onApply: (settings: CameraSettings) => void }) {
  const parsed = parseCameraSettings(cameraSettings);
  const [settings, setSettings] = useState<CameraSettings>(() => ({ ...(parsed ?? CAMERA_DEFAULTS) }));
  const set = (key: keyof CameraSettings, value: string | boolean | null) => setSettings(current => ({ ...current, [key]: value }));
  return <Modal className="camera-modal" title="机位控制" subtitle="选择机位，预览后应用到草稿" ariaLabel="机位控制" onClose={onClose} footer={<><button className="button button--quiet camera-reset" onClick={() => setSettings({...CAMERA_DEFAULTS})}>恢复初始</button><button className="button" onClick={onClose}>取消</button><button className="button button--primary" onClick={() => onApply(settings)}>应用到草稿</button></>}>
    <div className="camera-control">
      {cameraSettings !== undefined && !parsed && <p className="camera-warning" role="alert">无法解析现有机位设置，已使用初始设置；应用时将覆盖。</p>}
      <div className="camera-presets">
        <section><h3>方位 <small>相对主体</small></h3><div className="camera-toggle-options" role="group" aria-label="方位">{(Object.keys(CAMERA_DIRECTIONS) as Array<NonNullable<CameraSettings["direction"]>>).map(direction => <button key={direction} aria-pressed={settings.direction === direction} title={directionWords[direction]} onClick={() => set("direction", settings.direction === direction ? null : direction)}>{CAMERA_DIRECTIONS[direction]}</button>)}</div></section>
        <section><h3>高度</h3><div className="camera-toggle-options" role="group" aria-label="高度">{(Object.keys(CAMERA_HEIGHTS) as Array<NonNullable<CameraSettings["height"]>>).map(height => <button key={height} aria-pressed={settings.height === height} title={heightWords[height]} onClick={() => set("height", settings.height === height ? null : height)}>{CAMERA_HEIGHTS[height]}</button>)}</div></section>
        <section className="camera-shots"><h3>景别 <small>由近到远</small></h3><div role="group" aria-label="景别">{Object.keys(CAMERA_SHOTS).map(shot => <button key={shot} aria-pressed={settings.shot===shot} title={CAMERA_SHOTS[shot]} onClick={() => set("shot",settings.shot === shot ? null : shot)}>{shot}</button>)}</div></section>
        <section><h3>观察视角</h3><div className="camera-view-options" role="group" aria-label="观察视角">{(Object.keys(CAMERA_VIEWS) as Array<NonNullable<CameraSettings["view"]>>).map(view => <button key={view} aria-pressed={settings.view === view} title={view === "female_pov" ? "从女性观察者的视角观看 · female pov" : view === "pov" ? "第一人称视角 · pov" : "从前景人物肩后看向目标 · over-the-shoulder shot"} onClick={() => setSettings(current => changeCameraView(current, current.view === view ? null : view))}>{CAMERA_VIEWS[view]}</button>)}</div>
          {(settings.view === "pov" || settings.view === "female_pov") && <div className="camera-view-body"><span className="camera-sub-label">入镜 <small>可多选</small></span><div className="camera-view-options" role="group" aria-label="观察者入镜">{(Object.keys(CAMERA_BODY) as Array<keyof typeof CAMERA_BODY>).map(key => <button key={key} aria-pressed={settings[key]} title={"观察者自己的" + CAMERA_BODY[key] + " · pov " + key} onClick={() => set(key, !settings[key])}>{CAMERA_BODY[key]}</button>)}</div></div>}
        </section>
        <section><h3>透视</h3><div className="camera-effect-options"><button aria-pressed={settings.perspective} title="强调纵深与立体感 · perspective" onClick={() => setSettings(current => changeCameraPerspective(current, !current.perspective))}>强调透视</button>{settings.perspective && <button aria-pressed={settings.foreshortening} title="朝向镜头的部分沿纵深缩短 · foreshortening" onClick={() => set("foreshortening", !settings.foreshortening)}>透视缩短</button>}</div></section>
        <section><h3>虚化 <small>可多选</small></h3><div className="camera-effect-options">{(["backgroundBlur", "foregroundBlur"] as const).map(key => <button key={key} aria-pressed={settings[key]} title={CAMERA_EFFECTS[key].word} onClick={() => set(key, !settings[key])}>{CAMERA_EFFECTS[key].label}</button>)}</div></section>
      </div>
      <div className="camera-preview"><span>Prompt 预览</span><output aria-label="机位 Prompt 预览">{createCameraFragment(settings).description || "当前参数不输出机位提示词；应用将移除已有机位描述。"}</output></div>
    </div>
  </Modal>;
}
