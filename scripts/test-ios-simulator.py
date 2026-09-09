"""Install/launch the unsigned test archive on an isolated macOS CI runner."""
import json
import os
from pathlib import Path
import subprocess
import time


def run(*args, timeout=120):
    print('Running: ' + ' '.join(args), flush=True)
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        print(error.stdout or '', flush=True)
        print(error.stderr or '', flush=True)
        raise
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed ({result.returncode}): {result.stderr or result.stdout}')
    return result.stdout


def main():
    if os.environ.get('CI') != 'true':
        raise SystemExit('Run this smoke test on an isolated CI runner.')
    apps = list(Path('apps/web/src-tauri/gen/apple').rglob('*.xcarchive/Products/Applications/*.app'))
    if len(apps) != 1:
        raise RuntimeError(f'Expected one simulator app, found {len(apps)}')
    devices = json.loads(run('xcrun', 'simctl', 'list', 'devices', 'available', '--json'))['devices']
    candidates = [device for runtime, entries in devices.items() if '.iOS-' in runtime
                  for device in entries if device.get('isAvailable') and device['name'].startswith('iPhone')]
    if not candidates:
        raise RuntimeError('No available iPhone simulator')
    device = candidates[0]
    udid = device['udid']
    booted_here = device['state'] != 'Booted'
    try:
        if booted_here:
            run('xcrun', 'simctl', 'boot', udid)
        run('xcrun', 'simctl', 'bootstatus', udid, '-b', timeout=600)
        run('xcrun', 'simctl', 'install', udid, str(apps[0]))
        print(run('xcrun', 'simctl', 'launch', '--terminate-running-process', udid, 'org.bittrees.chirpy'))
        # Allow the bundled webview to paint before the OS return-link prompt covers it.
        time.sleep(15)
        output = Path('test-results/ios-simulator')
        output.mkdir(parents=True, exist_ok=True)
        run('xcrun', 'simctl', 'io', udid, 'screenshot', str(output / 'launch.png'))
        run('xcrun', 'simctl', 'openurl', udid, 'chirpy://acceptance')
        time.sleep(3)
        run('xcrun', 'simctl', 'io', udid, 'screenshot', str(output / 'return-url.png'))
        print(f'Installed and launched on {device["name"]}; OS accepted the registered return URL. Confirmation and wallet handoff require separate acceptance.')
    finally:
        if booted_here:
            run('xcrun', 'simctl', 'shutdown', udid)


if __name__ == '__main__':
    main()
