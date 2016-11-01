// @flow

const RestClient = require('../../api/RestClient')
const { prettyPrint } = require('../util')

module.exports = {
  command: 'statement <statementId>',
  description: 'Retrieve a statement from the local node by its id.\n',
  handler: (opts: {statementId: string, apiUrl: string}) => {
    const {statementId, apiUrl} = opts
    const client = new RestClient({apiUrl})

    client.statement(statementId)
      .then(
        prettyPrint,
        err => console.error(err.message)
      )
  }
}
