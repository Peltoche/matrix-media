const { BaseKonnector, log } = require('cozy-konnector-libs')
const axios = require('axios')

module.exports = new BaseKonnector(start)

const batchSize = 10

async function start(fields) {
  log('info', 'Authenticating ...')

  let roomID
  // we know that if the first character is a '#', we have an alias not an id
  if (fields.roomID[0] === '#') {
    log('info', 'Fetch room id')
    roomID = await axios({
      baseURL: fields.instanceURL,
      url: `/_matrix/client/r0/directory/room/${encodeURIComponent(
        fields.room
      )}`,
      headers: {
        Authorization: `Bearer ${fields.accessToken}`
      }
    }).data.room_id
  } else if (fields.roomID[0] === '!') {
    log('info', 'Have room id')
    roomID = fields.roomID
  } else {
    log('info', 'Invalid room id')
    throw "invalid room format, should start by '!' for an id or '#' for an alias"
  }

  roomID = encodeURIComponent(roomID)

  // First url fetching the last messages as we don't have any context
  log('info', 'Fetch first messages')
  let res = await axios({
    baseURL: fields.instanceURL,
    url: `_matrix/client/r0/rooms/${roomID}/messages?limit=${batchSize}&dir=b`,
    headers: {
      Authorization: `Bearer ${fields.accessToken}`
    }
  })

  let msgs = res.data.chunk

  if (msgs.length === 0) {
    log('info', 'There is no event in the room')
    return
  }

  const encryptedMessages = msgs.find(e => e.type === 'm.room.encrypted')
  if (encryptedMessages) {
    throw new Error('encrypted rooms are not supported yet')
  }

  const files = processMessages(fields.instanceURL, msgs)
  if (files.length > 0) {
    log('info', `save ${files.length} files`)
    this.saveFiles(files, fields)
  }

  let lastEventId = encodeURIComponent(msgs[msgs.length - 1].event_id)

  while (msgs.length === batchSize) {
    log('info', 'Fetch more messages')
    res = await axios({
      baseURL: fields.instanceURL,
      url: `_matrix/client/r0/rooms/${roomID}/context/${lastEventId}?limit=${batchSize}&dir=b`,
      headers: {
        Authorization: `Bearer ${fields.accessToken}`
      }
    })

    msgs = res.data.events_before

    const files = processMessages(fields.instanceURL, msgs)
    if (files.length > 0) {
      log('info', `save ${files.length} files`)
      this.saveFiles(files, fields)
    }

    lastEventId = encodeURIComponent(msgs[msgs.length - 1].event_id)
  }
}

function processMessages(instanceURL, messages) {
  return (
    messages
      // Keep only the images
      .filter(msg => msg.content.msgtype === 'm.image')
      .map(msg => {
        // Fetch the mxc looking like `mxc://{instanceName}/{some-id}`
        const mxcUrl = msg.content.url

        // We want to convert this mxc url into an http one looking like:
        // `https://{instanceURL}/_matrix/media/r0/download/{instanceName}/{some-id}`
        const parts = mxcUrl.split('/')
        return {
          fileIdAttributes: ['fileurl'],
          fileurl: `${instanceURL}/_matrix/media/r0/download/${parts[2]}/${parts[3]}`,
          filename: msg.content.body,
          contentType: msg.content.info.mimetype
        }
      })
  )
}
