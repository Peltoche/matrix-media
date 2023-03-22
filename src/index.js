const { BaseKonnector, log, normalizeFilename } = require('cozy-konnector-libs')
const axios = require('axios')

module.exports = new BaseKonnector(start)

const batchSize = 30

async function start(fields) {
  log('info', 'Authenticating ...')

  let roomID
  // we know that if the first character is a '#', we have an alias not an id
  if (fields.roomID[0] === '#') {
    log('info', 'Fetch room id')
    const res = await axios({
      baseURL: fields.instanceURL,
      url: `/_matrix/client/r0/directory/room/${encodeURIComponent(
        fields.roomID
      )}`,
      headers: {
        Authorization: `Bearer ${fields.accessToken}`
      }
    })
    roomID = res.data.room_id
  } else if (fields.roomID[0] === '!') {
    log('info', 'Have room id')
    roomID = fields.roomID
  } else {
    log('info', 'Invalid room id')
    throw new Error("invalid room format, should start by '!' for an id or '#' for an alias")
  }

  roomID = encodeURIComponent(roomID)

  // It is impossible for us to know the first event accessible so we need to trick a little.
  // - For the first run we will start from the latest message and we will read the events backward
  // until the oldest message. We also need to save the first bookmark, the one corresponding to the
  // latest messages and not the
  const accountData = await this.getAccountData()
  if (!accountData || !accountData[roomID]) {
    await this.saveAccountData({ [roomID]: { direction: 'b' }})
  }

  const url = `_matrix/client/r0/rooms/${roomID}/messages?limit=${batchSize}`

  while (true) {
    let data = await this.getAccountData()[roomID]

    log('info', data)

    let u = url + `&dir=${data.direction}`
    if (data.from) {
      u = u + `&from=${data.from}`
    }

    let res = await axios({
      baseURL: fields.instanceURL,
      url: u,
      headers: { Authorization: `Bearer ${fields.accessToken}` }
    })

    msgs = res.data.chunk

    if (!data.pivot || !data.roomName)  {
      // This is the first time we run the job and we have started to read
      // all the history backward. 
      // We save the data start because once we will have read all the history
      // backward we will start to read the history forward, starting at this event.
      data.pivot = res.data.start
      data.roomName = res.data.chunk.find(msg => msg.type === 'm.room.name').content.name
    }

    const files = processMessages(fields, msgs)
    if (files.length > 0) {
      log('info', `save ${files.length} files`)
      this.saveFiles(files, fields, {
        fileIdAttributes: ['filename'],
        validateFileContent: true,
        subPath: `/${data.roomName}`
      })
    }

    if (data.direction === 'b' && res.data.end) {
      // We are reading all the history backward and there is still content
      // so we update the bookmark
      data.from = res.data.end
    } else if (data.direction === 'b' && !res.data.end) {
      // We are reading all the history backward but we have reached the end
      // now we are starting to read the history forward from the earliest bookmark.
      data.direction = 'f'
      data.from = data.pivot
    } else if (data.direction === 'f' && res.data.end) {
      // We are reading the history forward
      data.from = res.data.end
    } else if (data.direction === 'f' && !res.data.end) {
      // We read the history forward and we have reached the last message: the sync is complete.
      break
    }

    await this.saveAccountData({ [roomID]: data})
  }
}

function processMessages(fields, messages) {

  return (
    messages
    // Keep only the selected media
    .filter(
      msg =>
      (fields.saveVideos && msg.content.msgtype === 'm.video') ||
      (fields.savePictures && msg.content.msgtype === 'm.image') ||
      (fields.saveOther && msg.content.msgtype === 'm.file')
    )
    .map(msg => {
      log('info', msg)
      // Fetch the mxc looking like `mxc://{instanceName}/{some-id}`
      const mxcUrl = msg.content.url

      // We want to convert this mxc url into an http one looking like:
      // `https://{instanceURL}/_matrix/media/r0/download/{instanceName}/{some-id}`
      const parts = mxcUrl.split('/')

      let attrs
      switch (msg.content.msgtype) {
        case 'm.video':
          attrs = { 
            class: 'video',
            metadata: {
              width: msg.content.info.w,
              height: msg.content.info.h
            }
          }
          break
        case 'm.image':
          attrs = { 
            class: 'image',
            metadata: {
              width: msg.content.info.w,
              height: msg.content.info.h
            }
          }
          break
        default:
          attrs = { class: 'document' }
          fileClass = 'document'
      }


      return {
        fileIdAttributes: ['filename'],
        fileurl: `${fields.instanceURL}/_matrix/media/r0/download/${parts[2]}/${parts[3]}`,
        filename: normalizeFilename(msg.content.body),
        contentType: msg.content.info.mimetype,
        fileAttributes: attrs
      }
    })
  )
}
