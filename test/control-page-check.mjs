// Manual check: control page key injection with a tricky key.
import { controlPageHandler } from '../src/control.js';

const captures = [];
const res = { writeHead() {}, end(b) { captures.push(b); } };
const KEY = ['sk-t$', '&', '$', '`', '<>', '"', "'x"].join('');
controlPageHandler({ method: 'GET' }, res, null, KEY);
const html = captures[0];

const stillPlaceholder = html.includes('__KEY__');
const m = /const KEY = '([^']*)'/.exec(html);
console.log('placeholder resolved:', stillPlaceholder ? 'NO (bug)' : 'yes');
console.log('injected raw text  :', m ? m[1] : 'NOT FOUND');
console.log('html-escaped ok    :', m && m[1] === 'sk-t$&amp;$`&lt;&gt;&quot;&#39;x' ? 'yes' : 'NO');
