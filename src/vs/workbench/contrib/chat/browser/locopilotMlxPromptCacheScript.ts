/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	MLX_PROMPT_CACHE_DIR_ENV,
	MLX_PROMPT_CACHE_EXT,
	MLX_PROMPT_CACHE_RESTORE_PATH,
	MLX_PROMPT_CACHE_SAVE_PATH,
} from './locopilotMlxServer.js';

// This file exists ONLY to hold the embedded Python module below. It is space-indented (Python's
// indentation IS its syntax, so it cannot be retabbed) and is therefore listed in build/filters.ts'
// indentationFilter exclusions - the same treatment zshBuiltinsCache.ts and the psreadline scripts
// get. Keeping it in its own file means the rest of the MLX code stays under the tab rule.

/**
 * Source of the helper module the launch bootstrap execs before handing control to mlx_lm's `main`.
 *
 * It gives mlx_lm.server the cross-restart prompt-cache persistence that llama.cpp gets from
 * `POST /slots/N?action=save|restore`. Without it every MLX server start re-prefills the entire
 * system+tools prefix - measured at 7661 tokens / ~29 s on an M3 - because mlx_lm's own
 * `--prompt-cache-bytes` LRU lives in the process and dies with it. mlx_lm exposes no equivalent
 * endpoint and no `--prompt-cache-file`, so we add the two operations ourselves.
 *
 * Kept as a string written to disk at launch (rather than a file under resources/mlx/) so the bundled
 * Python runtime that scripts/fetch-mlx-runtime.mjs produces stays untouched, and so an app update can
 * never leave a stale helper behind next to a newer runner: it is rewritten on every launch.
 *
 * Deliberately avoids backticks and dollar-brace so it survives this template literal unescaped.
 */
export const MLX_PROMPT_CACHE_HELPER_SOURCE = `"""LoCoPilot: cross-restart prompt-cache persistence for mlx_lm.server.

Adds POST /locopilot/prompt-cache/save and /restore, the moral equivalent of llama.cpp's
/slots/N?action=save|restore, so a warmed system+tools prefix survives a server restart instead of
being re-prefilled from scratch on the user's first message.

THREADING IS THE WHOLE DESIGN CONSTRAINT. mlx_lm serves HTTP on a ThreadingHTTPServer (a thread per
request) but owns every MLX array, and the LRU prompt cache, on a single generation thread. Mutating
or evaluating that state from a request thread would race the generation thread's own evaluation. So
the endpoints never touch the cache directly: they enqueue a job, and the job runs inside a wrapped
ResponseGenerator._next_request, which the generation loop calls on every iteration - that is, on the
one thread allowed to do the work.

The launch bootstrap execs this file BEFORE mlx_lm's main runs, so the classes are patched before the
server instantiates them: no polling, no race. The whole install is wrapped in try/except because a
failure here must degrade to a plain server that simply re-prefills, never to one that will not start.
"""

import json
import os
import queue

# (callable, reply_queue) pairs awaiting execution on the generation thread.
_JOBS = queue.Queue()
# Newest (model_key, tokens, prompt_cache) seen by insert_cache, for each cache_type mlx_lm uses.
#
# /save wants the 'system' one, NOT simply the newest. mlx_lm segments a chat prompt itself (see
# ResponseGenerator's sys_end scan) and inserts the system+tools span as its own 'system' entry
# alongside the full-prompt entry - and only the former is a strict PREFIX of the next turn.
#
# Persisting the newest entry instead is why a restore could report success and still buy nothing: the
# blob then carried the warm-up's own trailing user turn ('hi') plus its generated token, so on the next
# turn it is the 'longer' candidate in fetch_nearest_cache, which is reusable only when
# can_trim_prompt_cache() holds. That is false for exactly the models this matters most for -
# RotatingKVCache.is_trimmable() is 'offset < max_size', i.e. False for any sliding-window model whose
# prefix has grown past its window - so the cache was dropped and the whole prompt re-prefilled.
_LAST_INSERT = {'value': None, 'system': None}
# Generous: a save of a multi-thousand-token prefix writes ~1 GB and can queue behind a long prefill.
_JOB_TIMEOUT_S = 600.0


def _resolve(filename):
    """Join a bare filename to the configured cache dir, mirroring llama.cpp's --slot-save-path.

    basename() is not decoration: the name arrives over HTTP, and binding to 127.0.0.1 is not a
    reason to let a request write or read anywhere on the filesystem.
    """
    base = os.environ.get('${MLX_PROMPT_CACHE_DIR_ENV}') or ''
    if not base:
        raise RuntimeError('${MLX_PROMPT_CACHE_DIR_ENV} is not set')
    name = os.path.basename(str(filename or '').strip())
    if not name or name in ('.', '..'):
        raise ValueError('invalid filename')
    if not name.endswith('${MLX_PROMPT_CACHE_EXT}'):
        raise ValueError('prompt cache files must end in ${MLX_PROMPT_CACHE_EXT}')
    return os.path.join(base, name)


def _run_jobs():
    """Drain every pending job. MUST only be called on the generation thread."""
    while True:
        try:
            fn, reply = _JOBS.get_nowait()
        except queue.Empty:
            return
        try:
            reply.put((True, fn()))
        except Exception as e:
            reply.put((False, '{0}: {1}'.format(type(e).__name__, e)))


def _submit(fn):
    """Hand a job to the generation thread and block this request thread until it reports back."""
    reply = queue.Queue()
    _JOBS.put((fn, reply))
    try:
        ok, payload = reply.get(timeout=_JOB_TIMEOUT_S)
    except queue.Empty:
        raise RuntimeError('prompt cache job timed out after {0}s'.format(_JOB_TIMEOUT_S))
    if not ok:
        raise RuntimeError(payload)
    return payload


def _model_key_repr(model_key):
    return json.dumps([str(p) for p in (model_key or ())])


def _save(response_generator, path):
    from mlx_lm.models.cache import save_prompt_cache
    # Prefer the system+tools segment: it is the span that is stable across turns, so restoring it makes
    # every later prompt an extension of it (the cheap 'shorter' branch of fetch_nearest_cache, which
    # needs no trimming and therefore works for every cache class). The full-prompt entry is only a
    # fallback for a template with no system segment - it still restores, it just may not be reusable.
    entry = _LAST_INSERT['system'] or _LAST_INSERT['value']
    segment = 'system' if _LAST_INSERT['system'] is not None else 'prompt'
    if entry is None:
        raise RuntimeError('no prompt cache entry has been produced yet')
    model_key, tokens, prompt_cache = entry
    if not tokens:
        raise RuntimeError('refusing to save an empty prompt cache')
    metadata = {
        'tokens': json.dumps(tokens),
        'model_key': _model_key_repr(model_key),
        'segment': segment,
    }
    # Write beside the target and rename: a crash or an eviction mid-write must never leave a torn
    # blob that a later restore would happily load as a valid prefix.
    tmp = path + '.partial${MLX_PROMPT_CACHE_EXT}'
    save_prompt_cache(tmp, prompt_cache, metadata)
    os.replace(tmp, path)
    return {'saved': True, 'tokens': len(tokens), 'segment': segment, 'bytes': os.path.getsize(path)}


def _restore(response_generator, path):
    from mlx_lm.models.cache import load_prompt_cache
    model_key = response_generator.model_provider.model_key
    if model_key is None:
        raise RuntimeError('model is not loaded yet')
    prompt_cache, metadata = load_prompt_cache(path, return_metadata=True)
    tokens = json.loads(metadata.get('tokens') or '[]')
    if not tokens:
        raise RuntimeError('cache file carries no token metadata')
    saved_key = metadata.get('model_key') or ''
    # A cache restored under the wrong weights is worse than no cache: the tokens would not match the
    # KV, and the server has no way to notice. The caller already keys the filename by a prompt+tools
    # signature; this catches the remaining case of the same signature against a different model.
    if saved_key and saved_key != _model_key_repr(model_key):
        raise RuntimeError('cache was saved for a different model')
    # cache_type 'system' puts it in the LRU deque mlx_lm evicts LAST, which is what a stable
    # system+tools prefix wants.
    response_generator.prompt_cache.insert_cache(
        model_key, tokens, prompt_cache, cache_type='system'
    )
    return {'restored': True, 'tokens': len(tokens)}


def _install():
    from mlx_lm import server as _server
    from mlx_lm.models import cache as _cache

    lru_cls = _cache.LRUPromptCache
    generator_cls = _server.ResponseGenerator
    handler_cls = _server.APIHandler

    # Remember the newest entry of each kind so /save has something concrete to persist. The runner saves
    # right after the prefix warm-up, so the newest 'system' entry is exactly the warmed system+tools span.
    _orig_insert = lru_cls.insert_cache

    def insert_cache(self, model, tokens, prompt_cache, **kwargs):
        result = _orig_insert(self, model, tokens, prompt_cache, **kwargs)
        try:
            captured = (model, list(tokens), prompt_cache)
            _LAST_INSERT['value'] = captured
            if kwargs.get('cache_type') == 'system':
                _LAST_INSERT['system'] = captured
        except Exception:
            pass
        return result

    lru_cls.insert_cache = insert_cache

    # The generation loop polls this every iteration (non-blocking while busy, 0.1s while idle), so
    # it is both the correct thread and a naturally frequent tick for draining jobs.
    _orig_next_request = generator_cls._next_request

    def _next_request(self, timeout=None):
        _run_jobs()
        return _orig_next_request(self, timeout)

    generator_cls._next_request = _next_request

    _orig_do_post = handler_cls.do_POST
    routes = {'${MLX_PROMPT_CACHE_SAVE_PATH}': _save, '${MLX_PROMPT_CACHE_RESTORE_PATH}': _restore}

    def do_POST(self):
        path = (self.path or '').split('?')[0]
        handler = routes.get(path)
        if handler is None:
            return _orig_do_post(self)
        try:
            length = int(self.headers.get('Content-Length') or 0)
            body = json.loads(self.rfile.read(length) or b'{}')
            target = _resolve(body.get('filename'))
            generator = self.response_generator
            payload = _submit(lambda: handler(generator, target))
            status = 200
        except Exception as e:
            status = 400
            payload = {'error': '{0}: {1}'.format(type(e).__name__, e)}
        self._set_completion_headers(status)
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())
        self.wfile.flush()

    handler_cls.do_POST = do_POST


try:
    _install()
except Exception as _e:
    # Never block startup: without the patch the server just re-prefills, which is today's behaviour.
    import sys as _sys
    print('[locopilot] prompt cache persistence disabled: {0}'.format(_e), file=_sys.stderr)
`;
