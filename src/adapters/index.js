// Every source app Sello can import from. To add one, write a file like these (name,
// description, detect(src), read(src, options) yielding entries) and list it here.
import dayone from './dayone.js';
import generic from './generic.js';
import journey from './journey.js';
import markdown from './markdown.js';

// Detection tries them in this order: the specific formats before the catch-alls.
export const adapters = [journey, dayone, generic, markdown];

export const byName = (name) => adapters.find((a) => a.name === name);
export const detect = (src) => adapters.find((a) => a.detect(src));
