/**
 * Cloud Functions for Make Love Hub
 * ==================================
 * This is the missing piece behind "no push notification arrives when
 * I get a message". The app's client-side code (index.html) can only
 * REGISTER a device for push and SAVE its FCM token to Firestore — it
 * can never actually SEND a push to someone else's phone, because that
 * requires privileged server credentials that must never be shipped to
 * a browser/webview. Sending the push has to happen here, in a trusted
 * backend function that runs on Google's servers with the Admin SDK.
 *
 * DEPLOY:
 *   1. npm install -g firebase-tools   (if you don't have it yet)
 *   2. firebase login
 *   3. from your project root:  firebase init functions   (choose this
 *      existing `functions` folder, Node.js, JavaScript)
 *   4. copy this file's content into functions/index.js
 *   5. cd functions && npm install
 *   6. firebase deploy --only functions
 */

const {onDocumentCreated} = require('firebase-functions/v2/firestore');
const {initializeApp} = require('firebase-admin/app');
const {getFirestore, FieldValue} = require('firebase-admin/firestore');
const {getMessaging} = require('firebase-admin/messaging');

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

/**
 * Fires every time a new chat message is written to Firestore.
 * Looks up the recipient (the other participant in matchId), checks
 * neither side has blocked the other, and sends them a real push
 * notification via FCM using their saved device token.
 */
exports.onNewMessage = onDocumentCreated('messages/{messageId}', async (event) => {
  const msg = event.data?.data();
  if (!msg) return;

  const {matchId, from, content} = msg;
  if (!matchId || !from) return;

  const uids = matchId.split('_');
  const recipientUid = uids.find((u) => u !== from);
  if (!recipientUid) return;

  // don't push a message from someone the recipient has blocked, or
  // who has blocked the recipient
  const [blockA, blockB] = await Promise.all([
    db.collection('blocks').doc(`${from}_${recipientUid}`).get(),
    db.collection('blocks').doc(`${recipientUid}_${from}`).get(),
  ]);
  if (blockA.exists || blockB.exists) return;

  const [recipientSnap, senderSnap] = await Promise.all([
    db.collection('users').doc(recipientUid).get(),
    db.collection('users').doc(from).get(),
  ]);
  if (!recipientSnap.exists) return;
  const recipient = recipientSnap.data();
  const sender = senderSnap.exists ? senderSnap.data() : {};

  if (recipient.blocked) return; // suspended accounts get no pushes
  const token = recipient.fcmToken;
  if (!token) return; // this device never registered for push

  // keep a running unread-message count for this recipient — used for
  // the iOS app-icon badge number, and can also drive an in-app dot
  const newUnread = (recipient.unreadCount || 0) + 1;
  await recipientSnap.ref.update({unreadCount: newUnread});

  const senderName = sender.name || 'Someone';
  const senderPic = sender.photos?.find((p) => p.status === 'approved')?.url
    || (typeof sender.pic === 'string' ? sender.pic : '') || '';
  const bodyText = (content || '').slice(0, 120);

  try {
    await messaging.send({
      token,
      notification: {
        title: senderName,
        body: bodyText || 'Sent you a message',
      },
      data: {
        chatUid: from,
        chatName: senderName,
        chatPic: senderPic,
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'messages',
          sound: 'default',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: newUnread,
          },
        },
      },
    });
  } catch (err) {
    console.error('FCM send failed', err);
    // a common cause is a stale/uninstalled-app token — clean it up
    if (
      err.code === 'messaging/registration-token-not-registered' ||
      err.code === 'messaging/invalid-registration-token'
    ) {
      await recipientSnap.ref.update({fcmToken: FieldValue.delete()});
    }
  }
});

/**
 * Called by the app when the user opens a chat, to zero out their
 * unread badge count. (Wire this up from the client if/when you add
 * a callable — for now `unreadCount` can also just be reset directly
 * via a normal Firestore update from the client, since users are
 * always allowed to edit their own non-protected fields.)
 */
