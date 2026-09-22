import {spawnSync} from 'node:child_process';
const check=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8'});return{ok:r.status===0,version:(r.stdout||r.stderr||'').split(/\r?\n/)[0].trim()}};
console.log(JSON.stringify({node:process.version,ytDlp:check(process.env.YT_DLP_BIN||'yt-dlp',['--version']),ffmpeg:check(process.env.FFMPEG_BIN||'ffmpeg',['-version'])},null,2));
