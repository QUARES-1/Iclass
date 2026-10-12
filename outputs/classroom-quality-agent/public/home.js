import { api } from './ui.js';
try { const status=await api('/api/status');document.getElementById('home-model').textContent=status.textModelConfigured?'当前模型：'+status.model:'尚未配置模型，请先完成连接设置。'; }
catch { document.getElementById('home-model').textContent='模型状态暂时无法读取，可进入设置检查。'; }
