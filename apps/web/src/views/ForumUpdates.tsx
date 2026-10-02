import React from 'react';
import type {useForumFollow} from '../forumFollow';
export function ForumUpdates({forum}:{forum:ReturnType<typeof useForumFollow>}){
 return <section style={{padding:'24px',overflowY:'auto',maxWidth:800}} aria-label="Forum updates">
  <h1>Governance forum</h1>
  <p>Follow new discussions from gov.bittrees.org here in Bittrees Chat.</p>
  <p>Updates refresh every minute while Chat is open and visible. This preference is saved for your wallet on this device. These are public forum updates, not private messages or background push notifications.</p>
  {!forum.enabled?<p>Connect a wallet in Settings to save your subscription.</p>:<button className="btn" disabled={!forum.loaded} onClick={forum.prefs.following?forum.unfollow:forum.follow}>{forum.prefs.following?'Unfollow forum':'Follow forum'}</button>}
  {forum.error&&<p role="alert">{forum.error}</p>}
  {forum.prefs.following&&<><p>{forum.unread} unread updates</p><button className="btn" disabled={!forum.items.length} onClick={forum.markRead}>Mark updates as read</button>
    {!forum.items.length&&!forum.error&&<p>New discussions will appear here after you follow the forum.</p>}
    <ul style={{paddingLeft:20}}>{forum.items.map(item=><li key={item.id} style={{padding:'16px 0'}}><a href={item.url} target="_blank" rel="noreferrer">{item.title}</a>{item.time>forum.prefs.seen&&<strong> · New</strong>}<div>{new Date(item.time*1000).toLocaleString()}</div></li>)}</ul></>}
  <p><a href="https://gov.bittrees.org/forum" target="_blank" rel="noreferrer">Open forum and email subscription settings →</a></p>
 </section>;
}
