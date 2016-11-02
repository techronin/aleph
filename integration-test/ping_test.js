// @flow
/* eslint-env mocha */

const assert = require('assert')
const { describe, it } = require('mocha')

const { loadTestNodeIds } = require('../test/util')
const nodeIds = loadTestNodeIds()
const AlephNode = require('../src/peer/node')
const { setConcatNodeStatus, concatNodePeerInfo, concatNodePeerId, directoryPeerInfo } = require('./util')

describe('Ping', () => {
  it('pings a concat node directly by PeerInfo', () => {
    const alephPeer = new AlephNode({peerId: nodeIds.pop()})
    return alephPeer.start()
      .then(() => setConcatNodeStatus('online'))
      .then(() => concatNodePeerInfo())
      .then(concatNodeInfo => alephPeer.ping(concatNodeInfo))
      .then(result => assert(result != null, 'ping failed'))
  })

  it('pings a concat node via a directory lookup', () => {
    const alephPeer = new AlephNode({peerId: nodeIds.pop()})
    return directoryPeerInfo()
      .then(dirInfo => alephPeer.setDirectory(dirInfo))
      .then(() => alephPeer.start())
      .then(() => setConcatNodeStatus('public'))
      .then(() => alephPeer.ping(concatNodePeerId()))
      .then(result => assert(result != null, 'ping failed'))
  })
})