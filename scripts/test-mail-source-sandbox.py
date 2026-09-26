"""Real systemd regression: WAL sidecars work; mailbox and credentials stay read-only.
Run as root only on a disposable Linux CI host. Never reads production data.
"""
import grp,json,os,pathlib,pwd,shutil,sqlite3,subprocess,uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]
def run(*args,check=True):
 return subprocess.run(args,check=check,capture_output=True,text=True,timeout=45)

def main():
 assert os.geteuid()==0 and pathlib.Path('/run/systemd/system').is_dir(),'Requires disposable root/systemd test host'
 name='chat-sqlite-'+uuid.uuid4().hex[:10];home=pathlib.Path('/home')/name
 unit='chat-source-sandbox-'+uuid.uuid4().hex[:10]+'.service';unit_path=pathlib.Path('/run/systemd/system')/unit
 template=(ROOT/'selfhost/systemd/mail-source/chat-mail-source@.service').read_text()
 allowed='ReadWritePaths=/home/raging/.local/state/bittrees-mail-chat-inbound\n'
 assert template.count(allowed)==1
 try:
  # No account provisioning: use the disposable runner's existing unprivileged identity.
  account=pwd.getpwnam('nobody');assert account.pw_uid!=0
  home.mkdir(mode=0o755)
  state=home/'.local/state/bittrees-mail-chat-inbound';state.mkdir(parents=True,mode=0o700)
  config=home/'.config/bittrees-mail';config.mkdir(parents=True);(config/'fixture.json').write_text('{"fixture":true}')
  mail=home/'Maildir';mail.mkdir();(mail/'fixture.eml').write_text('Synthetic message only')
  dbpath=state/'outbox.sqlite';db=sqlite3.connect(dbpath);assert db.execute('pragma journal_mode=WAL').fetchone()[0]=='wal'
  db.execute('create table fixture(value integer)');db.execute('insert into fixture values(7)');db.commit();db.close()
  for p in [home,*home.rglob('*')]:os.chown(p,account.pw_uid,account.pw_gid)
  state.chmod(0o700);dbpath.chmod(0o600);(config/'fixture.json').chmod(0o600)
  assert not pathlib.Path(str(dbpath)+'-wal').exists() and not pathlib.Path(str(dbpath)+'-shm').exists()
  script=home/'check.py'
  code=r'''
import json,pathlib,sqlite3,sys
home=pathlib.Path(__file__).parent;state=home/'.local/state/bittrees-mail-chat-inbound';expected=sys.argv[1]=='fixed'
for p in [home/'.config/bittrees-mail/fixture.json',home/'Maildir/fixture.eml',home/'outside-state']:
 try:
  with p.open('a') as f:f.write('must not write')
 except OSError:pass
 else:raise AssertionError('Writable protected file')
readonly_failed=False;db=None
try:
 db=sqlite3.connect('file:'+str(state/'outbox.sqlite')+'?mode=ro',uri=True)
 assert db.execute('select value from fixture').fetchone()[0]==7
 try:db.execute('update fixture set value=8')
 except sqlite3.OperationalError:pass
 else:raise AssertionError('Read-only database accepted update')
except sqlite3.OperationalError as e:
 print(json.dumps({'sqliteFailure':str(e)}),flush=True)
 assert 'readonly' in str(e).lower();readonly_failed=True
finally:
 if db is not None:db.close()
assert readonly_failed is not expected
print(json.dumps({'sandboxAccepted':True,'sidecarAccess':expected,'protectedFilesReadOnly':True}),flush=True)
'''
  script.write_text(code);script.chmod(0o444)
  for mode in ['original','fixed']:
   body=template.replace('User=raging','User='+account.pw_name).replace('Group=raging','Group='+grp.getgrgid(account.pw_gid).gr_name)
   if mode=='original':body=body.replace(allowed,'')
   body=body.replace('/home/raging',str(home)).replace('Type=exec','Type=oneshot').replace('StandardInput=socket','StandardInput=null').replace('StandardOutput=inherit','StandardOutput=journal').replace('StandardError=null','StandardError=journal')
   body='\n'.join(('ExecStart=/usr/bin/python3 -B -I '+str(script)+' '+mode) if line.startswith('ExecStart=') else line for line in body.splitlines())+'\n'
   unit_path.write_text(body);run('systemctl','daemon-reload')
   started=run('systemctl','start',unit,check=False)
   if started.returncode:
    print('Synthetic sandbox failure in '+mode,flush=True)
    print(run('journalctl','-u',unit,'--no-pager','-o','cat').stdout,flush=True)
    raise AssertionError('Sandbox fixture service failed')
   logs=run('journalctl','-u',unit,'--no-pager','-o','cat').stdout
   expected={'sandboxAccepted':True,'sidecarAccess':mode=='fixed','protectedFilesReadOnly':True}
   assert any(line==json.dumps(expected) for line in logs.splitlines()),'Missing actual service acceptance'
  assert (config/'fixture.json').read_text()=='{"fixture":true}' and (mail/'fixture.eml').read_text()=='Synthetic message only'
  print('Actual systemd regression passed: original sandbox fails SQLite read; scoped state exception works; protected files and database writes remain denied.')
 finally:
  run('systemctl','stop',unit,check=False)
  if unit_path.exists():unit_path.unlink()
  run('systemctl','daemon-reload',check=False);run('systemctl','reset-failed',unit,check=False)
  if home.exists():shutil.rmtree(home)
if __name__=='__main__':main()
