import test from 'node:test';import assert from 'node:assert/strict';import {videoSelector,audioQuality} from '../src/extractor.js';import {isPrivateIp} from '../src/security.js';
test('quality selectors',()=>{assert.match(videoSelector('720'),/height<=720/);assert.equal(videoSelector('best'),'bv*+ba/b');assert.equal(audioQuality('320'),'320K')});
test('private IP detection',()=>{for(const x of ['127.0.0.1','10.0.0.1','192.168.1.1','172.16.0.1','::1','fc00::1'])assert.equal(isPrivateIp(x),true);assert.equal(isPrivateIp('8.8.8.8'),false)});
