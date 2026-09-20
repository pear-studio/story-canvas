// 项目复制与事实发现共用的当前文件边界；生成成果和运行数据不在其中。
export const projectFactDirectories = ["materials", "characters", "scenes", "pages", "story", "lettering", "finished"];
export const projectSettingFiles = ["project.json", "creative-agreement.json", "render-profile.override.json", ".gitignore", ".gitattributes"];

export const projectGitignore = `/Outputs/
/Saved/
/models/
/config.local.json
/.env*
*.pem
*.key
*.safetensors
*.ckpt
*.pt
*.pth
*.bin
*.gguf
*.partial
*.tmp
Thumbs.db
.DS_Store
`;

// 禁止 Git 改写材料和 Caption 的字节，保留已有哈希确认。
export const projectGitattributes = `materials/** -text
`;
