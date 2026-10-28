"""Fixed local observer of existing systemd health receipts. Never runs a worker.

No installation or SSH authorization is supplied by this file. Use only after a
reviewed operator grants access to these exact units and their aggregate logs.
"""
import json
import os
import re
import select
import subprocess
import sys
import time
from pathlib import Path

UNITS = {
    'inbound': ('chat-mail-inbound-health.service', 'chat-mail-inbound-health.timer'),
    'outbound': ('chat-mail-api-scheduler.service', 'chat-mail-api-scheduler.timer'),
}
SERVICE_FIELDS = ('Id', 'LoadState', 'ActiveState', 'Result', 'ExecMainStatus',
                  'InvocationID', 'ExecMainExitTimestampMonotonic')
TIMER_FIELDS = ('Id', 'LoadState', 'ActiveState', 'UnitFileState')
JOURNAL_FIELDS = '_SYSTEMD_UNIT,_SYSTEMD_INVOCATION_ID,_BOOT_ID,__MONOTONIC_TIMESTAMP,MESSAGE'
MAX_AGE_MS = 300_000


def command(argv, timeout=3, limit=16_384):
    """Bound memory and elapsed time even for an oversized/stalled journal."""
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, shell=False, close_fds=True,
                               env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
    deadline = time.monotonic() + timeout
    data = bytearray()
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([process.stdout], [], [], remaining)[0]:
                raise ValueError('Observer command deadline')
            chunk = os.read(process.stdout.fileno(), min(4096, limit + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > limit:
                raise ValueError('Observer command size')
        if process.wait(timeout=max(0.001, deadline - time.monotonic())) != 0:
            raise ValueError('Observer command unavailable')
        return data.decode('utf-8', errors='strict')
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()


def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError('Duplicate observation field')
        result[key] = value
    return result


def decode(value):
    return json.loads(value, object_pairs_hook=pairs)


def integer(value):
    return type(value) is int and 0 <= value <= 9_007_199_254_740_991


def properties(unit, fields, run):
    value = run(['/usr/bin/systemctl', 'show', '--no-pager',
                 '--property=' + ','.join(fields), unit])
    rows = pairs(line.split('=', 1) for line in value.strip().splitlines())
    if set(rows) != set(fields) or rows['Id'] != unit or rows['LoadState'] != 'loaded':
        raise ValueError('Unrecognized supervisor state')
    return rows


def payload_status(component, value, wall_ms):
    """Validate fixed aggregate schemas; return no source body or identifiers."""
    if isinstance(value, dict) and set(value) == {'enabled', 'status'} and value['enabled'] is False and value['status'] == 'disabled':
        return 'disabled', None
    if not isinstance(value, dict) or value.get('enabled') is not True:
        raise ValueError('Invalid health receipt')
    checked = value.get('checkedAt')
    if not integer(checked) or not 0 < checked <= wall_ms + 30_000 or wall_ms - checked > MAX_AGE_MS:
        raise ValueError('Stale health clock')
    if component == 'inbound':
        if set(value) != {'enabled', 'status', 'checkedAt', 'queue', 'worker', 'sender'}:
            raise ValueError('Invalid inbound fields')
        queue, worker, sender = value['queue'], value['worker'], value['sender']
        if set(queue) != {'pending', 'due', 'expired', 'staleClaims', 'orphaned', 'corrupt', 'oldestAgeMs'} or not all(integer(n) for n in queue.values()):
            raise ValueError('Invalid inbound counts')
        if set(worker) != {'lastAttemptAt', 'lastSuccessAt', 'lastOutcome'} or set(sender) != {'guarded', 'uncertain'} or not all(type(b) is bool for b in sender.values()):
            raise ValueError('Invalid inbound state')
        tick = worker['lastSuccessAt']
        attempt = worker['lastAttemptAt']
        fresh = integer(tick) and tick > 0 and integer(attempt) and tick <= attempt <= checked and checked - tick <= MAX_AGE_MS
        healthy = fresh and worker['lastOutcome'] in ('idle', 'published', 'stopped') and not sender['uncertain'] and queue['pending'] <= 1000 and queue['due'] <= queue['pending'] and queue['oldestAgeMs'] <= MAX_AGE_MS and not any(queue[k] for k in ('expired', 'staleClaims', 'orphaned', 'corrupt'))
        if value['status'] not in ('healthy', 'degraded') or (value['status'] == 'healthy') != bool(healthy):
            raise ValueError('Inconsistent inbound health')
    else:
        fields = {'enabled', 'status', 'workerHealthy', 'providerBlocked', 'checkedAt', 'lastSuccessfulTickAt', 'queued', 'due', 'oldestDueAgeMs', 'uncertainCount'}
        if set(value) not in (fields, fields | {'processed'}) or not all(integer(value[k]) for k in ('queued', 'due', 'oldestDueAgeMs', 'uncertainCount')) or value['due'] > value['queued']:
            raise ValueError('Invalid outbound fields')
        if 'processed' in value and (not integer(value['processed']) or value['processed'] > 1):
            raise ValueError('Invalid tick result')
        if type(value['workerHealthy']) is not bool or type(value['providerBlocked']) is not bool:
            raise ValueError('Invalid outbound state')
        tick = value['lastSuccessfulTickAt']
        healthy = integer(tick) and tick > 0 and tick <= checked and checked - tick <= MAX_AGE_MS and not value['providerBlocked'] and value['uncertainCount'] == 0 and value['oldestDueAgeMs'] <= MAX_AGE_MS
        if value['workerHealthy'] != bool(healthy) or value['status'] != ('ok' if healthy else 'degraded'):
            raise ValueError('Inconsistent outbound health')
    # Validate the source's own conclusion at checkedAt above, then independently
    # age its heartbeat at observation time. A recently cached report cannot
    # extend a worker's five-minute freshness window by another five minutes.
    healthy = bool(healthy) and -30_000 <= wall_ms - tick <= MAX_AGE_MS
    return ('healthy' if healthy else 'degraded'), max(0, wall_ms - tick) if integer(tick) else None


def observe_component(component, run, monotonic_us, wall_ms, boot):
    service, timer = UNITS[component]
    timer_state = properties(timer, TIMER_FIELDS, run)
    if timer_state['UnitFileState'] != 'enabled' or timer_state['ActiveState'] != 'active':
        return {'component': component, 'status': 'disabled', 'reason': 'timer_not_enabled_active'}
    state = properties(service, SERVICE_FIELDS, run)
    invocation = state['InvocationID']
    exited = state['ExecMainExitTimestampMonotonic']
    if state['ActiveState'] != 'inactive' or state['Result'] != 'success' or state['ExecMainStatus'] != '0':
        return {'component': component, 'status': 'degraded', 'reason': 'health_run_not_successful_idle'}
    # systemd's initial Result=success/Status=0 proves nothing without a real run.
    if not re.fullmatch('[a-f0-9]{32}', invocation) or not re.fullmatch('[0-9]{1,18}', exited) or not 0 < int(exited) <= monotonic_us or monotonic_us - int(exited) > MAX_AGE_MS * 1000:
        raise ValueError('Missing or stale execution')
    raw = run(['/usr/bin/journalctl', '--no-pager', '--quiet', '--boot=0', '-n', '1',
               '--output=json', '--output-fields=' + JOURNAL_FIELDS,
               '_SYSTEMD_UNIT=' + service, '_SYSTEMD_INVOCATION_ID=' + invocation])
    report = decode(raw)
    if not isinstance(report, dict) or report.get('_SYSTEMD_UNIT') != service or report.get('_SYSTEMD_INVOCATION_ID') != invocation or report.get('_BOOT_ID') != boot:
        raise ValueError('Foreign health receipt')
    at = report.get('__MONOTONIC_TIMESTAMP')
    message = report.get('MESSAGE')
    if not isinstance(at, str) or not re.fullmatch('[0-9]{1,18}', at) or not 0 < int(at) <= monotonic_us or monotonic_us - int(at) > MAX_AGE_MS * 1000 or not isinstance(message, str) or len(message.encode('utf-8')) > 4096:
        raise ValueError('Invalid health receipt bounds')
    status, heartbeat_age = payload_status(component, decode(message), wall_ms)
    return {'component': component, 'status': status, 'reportAgeMs': (monotonic_us - int(at)) // 1000,
            'workerHeartbeatAgeMs': heartbeat_age}


def observe(run=command, monotonic_us=None, wall_ms=None, boot=None):
    monotonic_us = time.monotonic_ns() // 1000 if monotonic_us is None else monotonic_us
    wall_ms = time.time_ns() // 1_000_000 if wall_ms is None else wall_ms
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip().replace('-', '') if boot is None else boot
    if not integer(monotonic_us) or not integer(wall_ms) or not isinstance(boot, str) or not re.fullmatch('[a-f0-9]{32}', boot):
        raise ValueError('Invalid observer clock or boot')
    components = []
    for component in UNITS:
        try:
            components.append(observe_component(component, run, monotonic_us, wall_ms, boot))
        except Exception:
            components.append({'component': component, 'status': 'unavailable', 'reason': 'matching_fresh_aggregate_unavailable'})
    status = next((s for s in ('unavailable', 'degraded', 'disabled') if any(c['status'] == s for c in components)), 'healthy')
    return {'version': 1, 'status': status, 'components': components,
            'readOnly': True, 'workerStarted': False, 'mailSent': False}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 1:
            raise ValueError('No observer arguments accepted')
        result = observe()
    except Exception:
        result = {'version': 1, 'status': 'unavailable', 'reason': 'observer_unavailable',
                  'readOnly': True, 'workerStarted': False, 'mailSent': False}
    print(json.dumps(result, separators=(',', ':')))
    sys.exit(0 if result['status'] == 'healthy' else 2)
