import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { prepareDownload, saveMetadata } from '../utils/file-manager.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { get } from '../utils/config.js';
import fs from 'fs';
import path from 'path';

function selectVideoModel(requested) {
  const available = get('videoModels', {});
  if (!requested || requested === 'auto') {
    return 'Veo 3.1 - Fast';
  }
  if (requested === 'quality' || requested === 'premium') return 'Veo 3.1 - Quality';
  if (requested === 'fast' || requested === 'speed') return 'Veo 3.1 - Fast';
  if (requested === 'lite' || requested === 'test') return 'Veo 3.1 - Lite';
  if (requested === 'flash' || requested === 'simple') return 'Omni Flash';
  if (available[requested]) return requested;
  return null;
}

export async function handleGenerateVideo(args) {
  const autoConfirm = args.auto_confirm === true;
  const job = jobQueue.createJob('video_generation', {
    prompt: args.prompt,
    model: args.model || 'auto',
    ratio: args.ratio || '16:9',
    duration: args.duration || '4s',
    auto_confirm: autoConfirm,
    project_name: args.project_name,
    campaign: args.campaign,
  });

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    await ensureProjectInContext(page, {
      name: args.project_name,
      campaign: args.campaign,
    });

    const model = selectVideoModel(args.model);
    if (!model) {
      const available = Object.keys(get('videoModels', {}));
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `Video model "${args.model}" not available. Available: ${available.join(', ')}`,
        { requested: args.model, available });
    }
    logger.info('Using video model', { model });

    const duration = args.duration || '4s';

    // Find prompt input (agent bar, contenteditable/textarea)
    let promptInput = null;
    const promptCandidates = [
      page.locator('[contenteditable="true"]:visible').first(),
      page.locator('textarea:visible').first(),
      page.locator('[contenteditable="true"]').first(),
      page.locator('textarea').first(),
    ];
    for (const candidate of promptCandidates) {
      if (await candidate.isVisible().catch(() => false)) {
        promptInput = candidate;
        break;
      }
    }
    if (!promptInput) {
      await takeScreenshot(page, 'no-prompt-input-video');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Could not find prompt input for video');
    }

    // Flow is agent-first: an imperative prompt that names the model, duration
    // and "video" makes the agent generate directly instead of asking questions.
    const imperativePrompt =
      `Genera subito un video di ${duration} con il modello ${model}, senza farmi domande e senza chiedere chiarimenti: ${args.prompt}`;

    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await promptInput.click();
    await promptInput.fill('');
    await page.waitForTimeout(200);
    await promptInput.type(imperativePrompt, { delay: 12 });
    await page.waitForTimeout(500);

    // DECISION POINT — without auto_confirm we stop before spending credits.
    if (!autoConfirm) {
      const setupScreenshot = await takeScreenshot(page, 'video-ready-for-confirmation');
      const result = {
        status: 'ready_for_confirmation',
        type: 'video',
        message: 'Prompt video pronto. Nessun credito consumato. ' +
          'Per generare (consuma crediti Flow) richiama con auto_confirm=true.',
        model_used: model,
        duration,
        prompt: args.prompt,
        account: get('expectedAccount'),
        screenshot: setupScreenshot,
        jobId: job.id,
      };
      jobQueue.completeJob(job.id, result);
      return result;
    }

    // ⚠️ CREDITS: click submit (icon text is exactly "arrow_forward").
    logger.info('⚠️ auto_confirm=true — invio generazione video, consuma crediti');
    await takeScreenshot(page, 'video-pre-generate');
    const submit = page.locator('button:has(:text-is("arrow_forward"))').first();
    // The submit can take a moment to render in a freshly created project —
    // wait for it instead of checking once.
    try {
      await submit.waitFor({ state: 'visible', timeout: 12000 });
    } catch {
      await takeScreenshot(page, 'no-video-generate-btn');
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Video submit button not found');
    }
    await submit.click();

    // Poll for the generated video. Two things happen during this window and
    // both can appear late, so we handle them EACH iteration:
    //  1) A credit-confirmation dialog ("...che costa N crediti?" → Approva).
    //     It shows up seconds AFTER submit (the agent reasons first), so a
    //     fixed short wait misses it — click it whenever it appears.
    //  2) The finished video, which is slow (Veo takes minutes) and may live in
    //     any frame, as a <video> element or an <img> poster on the Flow media
    //     endpoint (media.getMediaUrlRedirect?name=UUID).
    const genTimeoutMs = get('videoGenerationTimeoutMs', 600000);
    const genStart = Date.now();
    let mediaUuids = [];
    let videoSrc = null;
    let approved = false;

    const scanFrame = (frame) => frame.evaluate(() => {
      const uuids = new Set();
      let vsrc = null;
      document.querySelectorAll('video').forEach(v => {
        const s = v.src || v.currentSrc || '';
        if (s) vsrc = s;
        const m = s.match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
        if (m) uuids.add(m[1]);
        const pm = (v.getAttribute('poster') || '').match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
        if (pm) uuids.add(pm[1]);
      });
      document.querySelectorAll('img').forEach(img => {
        const m = (img.src || '').match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
        if (m && img.width > 150) uuids.add(m[1]);
      });
      return { uuids: [...uuids], vsrc };
    }).catch(() => ({ uuids: [], vsrc: null }));

    while (Date.now() - genStart < genTimeoutMs) {
      await page.waitForTimeout(5000);

      // 1) Approve the credit dialog if present (any iteration, any frame).
      //    The "Approva" control is a <div> styled-component, NOT a <button>,
      //    so getByText (tag-agnostic, exact) is required. Exact avoids matching
      //    "Approva e non chiedermelo più".
      if (!approved) {
        for (const frame of page.frames()) {
          const approve = frame.getByText('Approva', { exact: true }).first();
          if (await approve.isVisible().catch(() => false)) {
            await approve.click().catch(() => {});
            approved = true;
            logger.info('Confirmation dialog approved (credits spent)');
            break;
          }
        }
      }

      // 2) Scan every frame for the produced media.
      const uuids = new Set();
      for (const frame of page.frames()) {
        const r = await scanFrame(frame);
        if (r.vsrc) videoSrc = r.vsrc;
        r.uuids.forEach(u => uuids.add(u));
      }
      if (uuids.size) {
        mediaUuids = [...uuids];
        logger.info('Video media detected', { count: mediaUuids.length, hasVideoEl: !!videoSrc, approved });
        if (videoSrc) break;
      }

      const elapsed = Math.round((Date.now() - genStart) / 1000);
      if (elapsed % 30 < 5) {
        await takeScreenshot(page, `video-wait-${elapsed}s`);
        logger.info('Still waiting for video...', { elapsed });
      }
    }

    if (!mediaUuids.length && !videoSrc) {
      await takeScreenshot(page, 'no-video-detected');
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        'Generation completed but no video was detected in the DOM. Check the Flow project library.');
    }

    // Download via authenticated session. Try the media endpoint for each UUID
    // and keep whatever comes back as video/*.
    const outputDir = args.output_folder || prepareDownload('video', model, job.id).dir;
    if (args.output_folder && !fs.existsSync(args.output_folder)) {
      fs.mkdirSync(args.output_folder, { recursive: true });
    }
    const downloadedFiles = [];

    for (const uuid of mediaUuids) {
      try {
        const response = await page.request.get(
          `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${uuid}`,
          { timeout: 60000 }
        );
        if (response && response.ok()) {
          const ct = response.headers()['content-type'] || '';
          if (ct.startsWith('video/')) {
            const buffer = await response.body();
            const destPath = path.join(outputDir, `flow_${uuid.substring(0, 8)}_${job.id}.mp4`);
            fs.writeFileSync(destPath, buffer);
            downloadedFiles.push(destPath);
            logger.info('Video downloaded', { uuid, size: buffer.length, path: destPath });
          }
        }
      } catch (err) {
        logger.warn('Failed to download video candidate', { uuid, error: err.message });
      }
    }

    if (!downloadedFiles.length) {
      await takeScreenshot(page, 'video-download-failed');
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        `Video generated but download failed. UUIDs seen: ${mediaUuids.join(', ') || 'none'}; videoSrc: ${videoSrc || 'none'}`);
    }

    saveMetadata(job.id, {
      type: 'video', model, duration, auto_confirm: true,
      prompt: args.prompt, files: downloadedFiles, jobId: job.id, mediaUuids,
    });

    jobQueue.completeJob(job.id, {
      status: 'success',
      type: 'video',
      account: get('expectedAccount'),
      model_used: model,
      duration,
      prompt: args.prompt,
      files: downloadedFiles,
      video_count: downloadedFiles.length,
      credits_consumed: true,
    });

    return jobQueue.getJob(job.id).result;
  } catch (err) {
    await takeScreenshot(getPage(), 'generate-video-error');
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
