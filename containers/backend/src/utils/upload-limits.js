'use strict';

// Single source of truth for the maximum upload size across the entire
// backend. Every Busboy/multer/whatever `fileSize` limit and every
// hand-rolled size check on an incoming request body imports MAX from
// here. There is NO per-endpoint variant — one size, every upload, no
// mental overhead to remember which endpoint has which ceiling.
//
// Kept identical to nginx's `client_max_body_size 1024g` in
// containers/frontend/nginx.conf so the outer proxy and the inner
// parser speak the same size in the same units.
//
// 1 TB is deliberately absurd: the largest realistic payload today is
// a ~130 GB North America map bundle. 7× headroom removes the need to
// ever revisit this number as content grows.

const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024 * 1024;

module.exports = { MAX_UPLOAD_BYTES };
