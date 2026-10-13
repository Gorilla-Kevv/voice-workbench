/**
 * 音色库 HTTP 接口（`/api/voicelib/*`，网关原生实现，不依赖任何 Python 服务）。
 *
 * 存在理由：音色库曾住在 GPT-SoVITS 服务（trainer :9881）里，而 GPT-SoVITS
 * 默认停用 —— 结果 IndexTTS / 网易页选个参考音频都得先把整个 GPT-SoVITS 拉起来。
 * 现在数据在仓库根 `voicelib/`（见 services/voiceLibrary.ts），网关常驻，
 * 任何模型都能直接取用。trainer 的 `/v1/voices*` 仍保留，读写同一份文件。
 *
 * 上传不走 multipart（网关没装 multer）：音频字节直接放请求体，
 * 元数据走查询参数（URLSearchParams 负责编码）。
 * 响应形状与 trainer 对齐：成功 `{ ok: true, voice | voices }`，
 * 失败 `{ ok: false, error: { code, message, retryable, hint } }`。
 */
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response, type Router as RouterType } from 'express';
import { Router } from 'express';
import {
  VoiceLibraryError,
  addRefClip,
  createVoice,
  createVoiceFromPath,
  deleteVoice,
  getRefClipPath,
  getVoice,
  getVoiceAudioPath,
  listVoices,
  removeRefClip,
  replaceVoiceAudio,
  updateRefClip,
  updateVoice,
  type UpdateVoicePatch,
} from '../services/voiceLibrary.js';

export const voicelibRouter: RouterType = Router();

const AUDIO_MIME: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.webm': 'audio/webm',
  '.aac': 'audio/aac',
  '.wma': 'audio/x-ms-wma',
};

function sendError(res: Response, error: unknown): void {
  if (error instanceof VoiceLibraryError) {
    res.status(error.status).json({
      ok: false,
      error: { code: error.code, message: error.message, retryable: false, hint: error.hint },
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  res.status(500).json({
    ok: false,
    error: { code: 'VOICELIB_FAILED', message, retryable: true, hint: '检查仓库根 voicelib/ 目录是否可写。' },
  });
}

/** 查询参数 → 创建音色元数据 */
function readMeta(req: Request) {
  const q = req.query as Record<string, string | undefined>;
  const num = (raw: string | undefined) => {
    const value = Number(raw);
    return raw != null && raw !== '' && Number.isFinite(value) ? value : null;
  };
  return {
    name: q.name ?? '',
    prompt_text: q.prompt_text ?? '',
    prompt_lang: q.prompt_lang ?? 'zh',
    note: q.note ?? '',
    tags: (q.tags ?? '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
    filename: q.filename,
    duration_s: num(q.duration_s),
    sample_rate: num(q.sample_rate),
    // 30-4：适用引擎标签（逗号分隔）。留空则不写该字段
    engine_tags: (q.engine_tags ?? '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
  };
}

const rawAudio = express.raw({ type: () => true, limit: '64mb' });

voicelibRouter.get('/', (_req: Request, res: Response) => {
  try {
    const voices = listVoices();
    res.json({ ok: true, voices, total: voices.length });
  } catch (error) {
    sendError(res, error);
  }
});

/** 必须在 '/:id' 之前注册，否则 'source' 会被当成音色 id */
voicelibRouter.post('/source', express.json(), (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const voice = createVoiceFromPath({
      name: String(body.name ?? ''),
      prompt_text: String(body.prompt_text ?? ''),
      prompt_lang: String(body.prompt_lang ?? 'zh'),
      note: String(body.note ?? ''),
      tags: String(body.tags ?? '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
      audio_path: String(body.audio_path ?? ''),
      engine_tags: String(body.engine_tags ?? '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
    });
    res.json({ ok: true, voice });
  } catch (error) {
    sendError(res, error);
  }
});

// --------------------------------------------------------------------------
// 日语长参考多片段（30-4）
//
// 必须在 `/:id` 之前注册（Express 按注册顺序匹配；虽然 `/:id` 只吃单段路径，
// 但显式排序能让「谁先谁后」不依赖对匹配规则的记忆）。
// 上传同样不走 multipart：字节放请求体，元数据走查询参数（与主音频一致）。
// --------------------------------------------------------------------------

/** 追加一片：请求体 = 音频原始字节，元数据 = 查询参数 */
voicelibRouter.post('/:id/ref-clips', rawAudio, (req: Request, res: Response) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const num = (raw: string | undefined) => {
      const value = Number(raw);
      return raw != null && raw !== '' && Number.isFinite(value) ? value : null;
    };
    const content = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const voice = addRefClip(req.params.id, content, q.filename ?? 'clip.wav', {
      duration_s: num(q.duration_s),
      sample_rate: num(q.sample_rate),
      text: q.text,
    });
    res.json({ ok: true, voice });
  } catch (error) {
    sendError(res, error);
  }
});

/** 试听某一片（按序号取，避免让前端传路径） */
voicelibRouter.get('/:id/ref-clips/:index/audio', (req: Request, res: Response) => {
  try {
    const filePath = getRefClipPath(req.params.id, Number(req.params.index));
    res.setHeader('Cache-Control', 'no-store');
    res.type(AUDIO_MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    if (!res.headersSent) sendError(res, error);
    else res.destroy();
  }
});

/** 改某片的转写文本 */
voicelibRouter.patch('/:id/ref-clips/:index', express.json(), (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { text?: string };
    res.json({ ok: true, voice: updateRefClip(req.params.id, Number(req.params.index), { text: body.text }) });
  } catch (error) {
    sendError(res, error);
  }
});

/** 删某一片 */
voicelibRouter.delete('/:id/ref-clips/:index', (req: Request, res: Response) => {
  try {
    res.json({ ok: true, voice: removeRefClip(req.params.id, Number(req.params.index)) });
  } catch (error) {
    sendError(res, error);
  }
});

voicelibRouter.get('/:id', (req: Request, res: Response) => {
  try {
    res.json({ ok: true, voice: getVoice(req.params.id) });
  } catch (error) {
    sendError(res, error);
  }
});

voicelibRouter.get('/:id/audio', (req: Request, res: Response) => {
  try {
    const filePath = getVoiceAudioPath(req.params.id);
    res.setHeader('Cache-Control', 'no-store');
    res.type(AUDIO_MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    if (!res.headersSent) sendError(res, error);
    else res.destroy();
  }
});

/** 上传音频登记新音色：请求体 = 音频原始字节，元数据 = 查询参数 */
voicelibRouter.post('/', rawAudio, (req: Request, res: Response) => {
  try {
    const meta = readMeta(req);
    const content = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const voice = createVoice({
      ...meta,
      content,
      filename: meta.filename ?? 'audio.wav',
    });
    res.json({ ok: true, voice });
  } catch (error) {
    sendError(res, error);
  }
});

voicelibRouter.post('/:id/audio', rawAudio, (req: Request, res: Response) => {
  try {
    const content = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const q = req.query as Record<string, string | undefined>;
    const num = (raw: string | undefined) => {
      const value = Number(raw);
      return raw != null && raw !== '' && Number.isFinite(value) ? value : null;
    };
    const voice = replaceVoiceAudio(req.params.id, content, q.filename ?? 'audio.wav', {
      duration_s: num(q.duration_s),
      sample_rate: num(q.sample_rate),
    });
    res.json({ ok: true, voice });
  } catch (error) {
    sendError(res, error);
  }
});

voicelibRouter.patch('/:id', express.json(), (req: Request, res: Response) => {
  try {
    const voice = updateVoice(req.params.id, (req.body ?? {}) as UpdateVoicePatch);
    res.json({ ok: true, voice });
  } catch (error) {
    sendError(res, error);
  }
});

voicelibRouter.delete('/:id', (req: Request, res: Response) => {
  try {
    deleteVoice(req.params.id);
    res.json({ ok: true, message: '音色已删除' });
  } catch (error) {
    sendError(res, error);
  }
});
