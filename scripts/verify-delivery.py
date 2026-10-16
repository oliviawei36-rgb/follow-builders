#!/usr/bin/env python3
# Confirm an actual assistant final response before recording delivery success.
import json, os, pathlib, sqlite3, sys
thread_id, digest_path, staged_at = sys.argv[1:]
normalize = lambda value: '\n'.join(line.rstrip() for line in value.replace('\r\n', '\n').strip().split('\n'))
digest = normalize(pathlib.Path(digest_path).read_text())
try:
    db = pathlib.Path(os.environ.get('FOLLOW_BUILDERS_CODEX_STATE_DB', str(pathlib.Path.home() / '.codex/state_5.sqlite')))
    with sqlite3.connect(f'file:{db}?mode=ro', uri=True) as conn:
        row = conn.execute('select rollout_path from threads where id=?', (thread_id,)).fetchone()
    if not row:
        raise RuntimeError('Delivery thread not found')
    evidence = None
    with pathlib.Path(row[0]).open() as stream:
        for line in stream:
            item = json.loads(line)
            if item.get('timestamp', '') < staged_at:
                continue
            payload = item.get('payload') or {}
            if item.get('type') != 'response_item' or payload.get('type') != 'message' or payload.get('role') != 'assistant':
                continue
            if payload.get('phase') not in ('final_answer', 'final'):
                continue
            text = '\n'.join(c.get('text', '') for c in (payload.get('content') or []))
            if digest and digest in normalize(text):
                evidence = {'responseId': payload.get('id'), 'deliveredAt': item.get('timestamp'), 'threadId': thread_id}
    print(json.dumps({'verified': bool(evidence), 'evidence': evidence}))
except Exception as error:
    print(json.dumps({'verified': False, 'error': str(error)}))
