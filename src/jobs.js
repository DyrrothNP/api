import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import {config} from './config.js';
import {
  assertDuration,
  videoSelector,
  audioSelector,
  audioQuality
} from './extractor.js';
import {run, killTree} from './process.js';


function safeFilename(name) {
  return String(name || 'download')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 180) || 'download';
}


export class JobManager {

  constructor() {
    this.jobs = new Map();
    this.queue = [];
    this.active = 0;
    this.stopped = false;
  }


  get(id) {
    return this.jobs.get(id);
  }


  create(request) {

    if (this.queue.length >= config.maxQueue) {
      throw new Error('Queue is full');
    }

    const id = crypto.randomUUID();

    const j = {
      id,
      status: 'queued',

      createdAt: Date.now(),
      updatedAt: Date.now(),

      progress: 0,

      title: null,
      thumbnail: null,
      metadata: null,

      file: null,
      fileName: null,
      size: null,

      error: null,

      request,

      events: [],
      listeners: new Set(),

      child: null
    };

    this.jobs.set(id, j);

    this.emit(j, 'queued');

    this.queue.push(id);

    this.pump();

    return j;
  }


  emit(j, type, extra = {}) {

    j.updatedAt = Date.now();

    const event = {
      type,
      progress: j.progress,
      time: Date.now(),
      ...extra
    };

    j.events.push(event);

    if (j.events.length > 300) {
      j.events.shift();
    }

    for (const listener of j.listeners) {

      try {
        listener(event);
      } catch {
        // Ignore disconnected SSE listeners.
      }

    }
  }


  subscribe(j, listener) {

    j.listeners.add(listener);

    return () => {
      j.listeners.delete(listener);
    };
  }


  pump() {

    while (
      !this.stopped &&
      this.active < config.maxConcurrent &&
      this.queue.length
    ) {

      const id = this.queue.shift();

      const j = this.jobs.get(id);

      if (!j || j.status !== 'queued') {
        continue;
      }

      this.active++;

      this.run(j)
        .catch(() => {})
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }


  async run(j) {

    j.status = 'downloading';

    this.emit(j, 'started');


    const dir = path.join(
      config.root,
      'storage',
      'downloads',
      j.id
    );


    await fs.mkdir(
      dir,
      {recursive: true}
    );


    const cleanup = () =>
      fs.rm(
        dir,
        {
          recursive: true,
          force: true
        }
      ).catch(() => {});


    try {

      /*
       * Inspect media first.
       * This also checks MAX_DURATION_SECONDS.
       */

      const info =
        await assertDuration(
          j.request.url
        );


      j.title =
        info.title;

      j.thumbnail =
        info.thumbnail;

      j.metadata =
        info;


      /*
       * Send metadata immediately
       * to connected SSE clients.
       */

      this.emit(
        j,
        'metadata',
        {
          title: info.title,
          thumbnail: info.thumbnail,
          metadata: info
        }
      );


      /*
       * User may have cancelled
       * while metadata was loading.
       */

      if (j.status === 'cancelled') {

        await cleanup();

        return;
      }


      /*
       * Create safe filename from title.
       *
       * Example:
       *
       * My Awesome Video.mp4
       * My Awesome Video.webm
       * My Awesome Video.mp3
       * My Awesome Video.m4a
       */

      const filename =
        safeFilename(
          info.title
        );


      /*
       * Force the extension selected
       * by the user.
       */

      const extension =
        j.request.format;


      const outputFilename =
        `${filename}.${extension}`;


      /*
       * Full output path.
       */

      const template =
        path.join(
          dir,
          outputFilename
        );


      const args = [];


      /*
       * Test harness script.
       */

      if (config.ytDlpScript) {
        args.push(
          config.ytDlpScript
        );
      }


      /*
       * Common yt-dlp options.
       */

      args.push(
        '--no-playlist',
        '--no-warnings',
        '--ignore-config',
        '--newline',
        '--socket-timeout',
        '30',

        '-o',
        template
      );


      /*
       * Cookies if configured.
       */

      if (config.cookiesFile) {

        args.push(
          '--cookies',
          config.cookiesFile
        );

      }


      /*
       * AUDIO
       */

      if (
        j.request.type === 'audio'
      ) {

        args.push(
          '-f',
          audioSelector(
            j.request.quality
          ),

          '-x',

          '--audio-format',
          j.request.format,

          '--audio-quality',
          audioQuality(
            j.request.quality
          )
        );

      }


      /*
       * VIDEO
       */

      else {

        args.push(
          '-f',
          videoSelector(
            j.request.quality
          ),

          '--merge-output-format',
          j.request.format
        );

      }


      /*
       * URL must be the final argument.
       */

      args.push(
        j.request.url
      );


      /*
       * Start yt-dlp.
       */

      const r =
        run(
          config.ytDlp,
          args,
          {
            timeout:
              config.processTimeout,

            onStdout:
              s => this.progress(
                j,
                s
              )
          }
        );


      j.child =
        r.child;


      /*
       * Monitor output size while
       * downloading.
       */

      const monitor =
        setInterval(
          () =>
            this.checkSize(
              j,
              dir
            ),
          150
        );


      try {

        await r.promise;

      } finally {

        clearInterval(
          monitor
        );

        j.child = null;
      }


      /*
       * If cancelled after yt-dlp
       * finished, remove everything.
       */

      if (
        j.status === 'cancelled'
      ) {

        await cleanup();

        return;
      }


      /*
       * Find the final output file.
       */

      const files =
        (
          await fs.readdir(dir)
        )
        .filter(
          f =>
            !f.endsWith('.part') &&
            !f.endsWith('.ytdl') &&
            !f.endsWith('.temp') &&
            !f.endsWith('.json')
        );


      if (files.length !== 1) {

        throw new Error(
          files.length
            ? 'Download produced an unexpected number of files'
            : 'Output file was not created'
        );

      }


      /*
       * Final file.
       */

      const file =
        path.join(
          dir,
          files[0]
        );


      const st =
        await fs.stat(
          file
        );


      /*
       * Final size check.
       */

      if (
        st.size >
        config.maxBytes
      ) {

        throw new Error(
          `File exceeds MAX_DOWNLOAD_BYTES (${config.maxBytes} bytes)`
        );

      }


      /*
       * Successful download.
       */

      j.file =
        file;

      j.fileName =
        files[0];

      j.size =
        st.size;

      j.progress =
        100;

      j.status =
        'completed';


      this.emit(
        j,
        'completed',
        {
          fileName:
            j.fileName,

          size:
            j.size
        }
      );


    } catch (e) {


      /*
       * Cancellation should not
       * become a failed job.
       */

      if (
        j.status === 'cancelled'
      ) {

        await cleanup();

        return;
      }


      j.status =
        'failed';


      j.error =
        e.message;


      j.progress =
        Math.min(
          j.progress,
          99.9
        );


      this.emit(
        j,
        'failed',
        {
          error:
            j.error
        }
      );


      await cleanup();
    }
  }


  progress(j, s) {

    for (
      const l of
      s.split(/\r?\n/)
    ) {

      const m =
        l.match(
          /(\d+(?:\.\d+)?)%/
        );


      if (m) {

        const p =
          Math.min(
            99.9,
            Number(m[1])
          );


        if (
          p > j.progress
        ) {

          j.progress =
            p;

          this.emit(
            j,
            'progress'
          );

        }
      }
    }
  }


  async checkSize(
    j,
    dir
  ) {

    if (
      j.status !== 'downloading'
    ) {
      return;
    }


    try {

      let total = 0;


      for (
        const f of
        await fs.readdir(dir)
      ) {

        const file =
          path.join(
            dir,
            f
          );


        const st =
          await fs.stat(
            file
          );


        if (
          st.isFile()
        ) {

          total +=
            st.size;

        }
      }


      if (
        total >
        config.maxBytes
      ) {

        j.error =
          `File exceeds MAX_DOWNLOAD_BYTES (${config.maxBytes} bytes)`;


        this.cancel(
          j.id,
          true
        );
      }


    } catch {
      // Ignore temporary filesystem errors.
    }
  }


  cancel(
    id,
    internal = false
  ) {

    const j =
      this.jobs.get(id);


    if (!j) {
      return null;
    }


    if (
      [
        'completed',
        'failed',
        'cancelled'
      ].includes(
        j.status
      )
    ) {

      return j;
    }


    /*
     * Remove queued jobs.
     */

    if (
      j.status === 'queued'
    ) {

      const i =
        this.queue.indexOf(id);


      if (i >= 0) {

        this.queue.splice(
          i,
          1
        );

      }
    }


    j.status =
      'cancelled';


    this.emit(
      j,
      'cancelled',
      internal
        ? {
            reason:
              j.error ||
              'cancelled'
          }
        : {}
    );


    /*
     * Kill yt-dlp / FFmpeg.
     */

    killTree(
      j.child
    );


    return j;
  }


  async cleanup() {

    const now =
      Date.now();


    for (
      const [id, j]
      of this.jobs
    ) {

      const ttl =
        j.status === 'completed'
          ? config.downloadTtl
          : config.jobTtl;


      if (
        now - j.updatedAt >
        ttl
      ) {

        this.jobs.delete(
          id
        );


        /*
         * Remove SSE listeners.
         */

        j.listeners.clear();


        /*
         * Remove downloaded files.
         */

        if (j.file) {

          await fs.rm(
            path.dirname(
              j.file
            ),
            {
              recursive: true,
              force: true
            }
          ).catch(() => {});

        }
      }
    }
  }


  stop() {

    this.stopped =
      true;


    for (
      const j
      of this.jobs.values()
    ) {

      if (
        j.status ===
        'downloading'
      ) {

        this.cancel(
          j.id
        );

      }
    }
  }
}
