// @flow

const fs = require('fs')
const { JQTransform } = require('../../../metadata/jqStream')
const objectPath = require('object-path')
const RestClient = require('../../api/RestClient')
const { validate, validateSelfDescribingSchema, isSelfDescribingRecord } = require('../../../metadata/schema')
import type { Readable } from 'stream'
import type { SelfDescribingSchema } from '../../../metadata/schema'

const BATCH_SIZE = 1000

type HandlerOptions = {
  namespace: string,
  schemaReference: string,
  apiUrl: string,
  jqFilter: string,
  idFilter: string,
  filename?: string,
  batchSize: number,
  compound?: number,
  dryRun: boolean,
  skipSchemaValidation: boolean
}

module.exports = {
  command: 'publish <namespace> <schemaReference> [filename]',
  description: 'publish a batch of statements from a batch of newline-delimited json. ' +
    'statements will be read from `filename` or stdin.\n',
  builder: {
    batchSize: { default: BATCH_SIZE },
    jqFilter: {
      description: 'a jq filter string to use to pre-process your input data',
      default: '.'
    },
    idFilter: {
      required: true,
      description: 'a jq filter that produces a mediachain identifier from your input object.  ' +
        'Will be applied after `jqFilter`, and does not modify the object itself.\n'
    },
    dryRun: {
      type: 'boolean',
      default: false,
      description: 'Only extract ids and print to the console.'
    },
    skipSchemaValidation: {
      type: 'boolean',
      default: false,
      description: "don't validate records against referenced schema before publishing.  Use only if you've " +
        'pre-validated your records! \n'
    },
    compound: {
      type: 'int',
      required: false,
      description: 'If present, publish compound statements of `compound` number of records. \n'
    }
  },

  handler: (opts: HandlerOptions) => {
    const {namespace, schemaReference, apiUrl, batchSize, filename, dryRun, skipSchemaValidation, jqFilter, idFilter, compound} = opts
    const publishOpts = {namespace, compound}
    const client = new RestClient({apiUrl})

    let stream: Readable
    let streamName = 'standard input'
    if (filename) {
      stream = fs.createReadStream(filename)
      streamName = filename
    } else {
      stream = process.stdin
    }

    client.getData(schemaReference)
      .catch(err => {
        throw new Error(`Failed to retrieve schema with object id ${schemaReference}: ${err.message}`)
      })
      .then((schema) => {
        try {
          schema = validateSelfDescribingSchema(schema)
        } catch (err) {
          throw new Error(
            `Schema with object id ${schemaReference} is not a valid self-describing schema: ${err.message}`
          )
        }
        publishStream({
          stream,
          streamName,
          client,
          batchSize,
          dryRun,
          skipSchemaValidation,
          publishOpts,
          schemaReference,
          schema,
          jqFilter: composeJQFilters(jqFilter, idFilter)})
      })
  }
}

function publishStream (opts: {
  stream: Readable,
  streamName: string,
  client: RestClient,
  batchSize: number,
  dryRun: boolean,
  skipSchemaValidation: boolean,
  publishOpts: {namespace: string, compound?: number},
  schemaReference: string,
  schema: SelfDescribingSchema,
  jqFilter: string
}) {
  const {
    stream,
    streamName,
    client,
    publishOpts,
    batchSize,
    dryRun,
    skipSchemaValidation,
    schemaReference,
    schema,
    jqFilter
  } = opts

  let statementBodies: Array<Object> = []
  let statements: Array<Object> = []
  const publishPromises: Array<Promise<*>> = []
  const jq = new JQTransform(jqFilter)

  let wki: string
  let obj: Object

  stream.pipe(jq)
    .on('data', jsonString => {
      try {
        const parsed = JSON.parse(jsonString)
        wki = parsed.wki
        obj = parsed.obj
      } catch (err) {
        throw new Error(`Error parsing jq output: ${err}\njq output: ${jsonString}`)
      }

      if (!skipSchemaValidation) {
        const result = validate(schema, obj)
        if (!result.success) {
          throw new Error(`Record failed validation: ${result.error.message}. Failed object: ${JSON.stringify(obj, null, 2)}`)
        }
      }

      if (wki == null || wki.length < 1) {
        throw new Error(
          `Unable to extract id. Input record: \n` +
          JSON.stringify(obj, null, 2)
        )
      }

      let selfDescribingObj
      if (isSelfDescribingRecord(obj)) {
        const ref = objectPath.get(obj, 'schema', '/')
        if (ref !== schemaReference) {
          throw new Error(
            `Record contains reference to a different schema (${ref}) than the one specified ${schemaReference}`
          )
        }
        selfDescribingObj = obj
      } else {
        selfDescribingObj = {
          schema: {'/': schemaReference},
          data: obj
        }
      }

      const refs = [wki]
      const tags = [] // TODO: support extracting tags

      if (dryRun) {
        console.log(`refs: ${JSON.stringify(refs)}, tags: ${JSON.stringify(tags)}`)
        return
      }

      const stmt = {object: selfDescribingObj, refs, tags}

      statementBodies.push(obj)
      statements.push(stmt)

      if (statementBodies.length >= batchSize) {
        publishPromises.push(
          publishBatch(client, publishOpts, statementBodies, statements)
        )
        statementBodies = []
        statements = []
      }
    })
    .on('error', err => console.error(`Error reading from ${streamName}: `, err))
    .on('end', () => {
      if (statementBodies.length > 0) {
        publishPromises.push(
          publishBatch(client, publishOpts, statementBodies, statements)
        )
      }
      Promise.all(publishPromises)
        .then(() => {
          if (!dryRun) {
            console.log('All statements published successfully')
          }
        })
        .catch(err => {
          console.error('Error publishing statements: ', err.message)
        })
    })
}

function publishBatch (client: RestClient,
                       publishOpts: {namespace: string, compound?: number},
                       statementBodies: Array<Object>,
                       statements: Array<Object>): Promise<*> {
  return client.putData(...statementBodies)
    .then(bodyHashes => {
      if (bodyHashes.length !== statements.length) {
        throw new Error(`Expected ${statements.length} results from putting data blobs, received ${bodyHashes.length}`)
      }
      statements = statements.map((s, i) => {
        s.object = bodyHashes[i]
        return s
      })

      return client.publish(publishOpts, ...statements)
        .then(statementIds => [bodyHashes, statementIds])
    })
    .then(([bodyHashes, statementIds]) => {
      printBatchResults(bodyHashes, statementIds, statements, publishOpts.compound || 1)
    })
}

function composeJQFilters (contentFilter: string, idFilter: string): string {
  return `${contentFilter} as $output | {wki: ($output | ${idFilter} | tostring), obj: $output}`
}

function printBatchResults (bodyHashes: Array<string>, statementIds: Array<string>, statements: Array<Object>,
                            compoundSize: number) {
  for (let i = 0; i < statementIds.length; i++) {
    const objectRefs = bodyHashes.slice(i, i + compoundSize)
    const stmts = statements.slice(i, i + compoundSize)
    const bodies = stmts.map((s, idx) => ({
      object: objectRefs[idx],
      refs: s.refs,
      tags: s.tags
    }))

    console.log(`\nstatement id: ${statementIds[i]}`)
    console.log(bodies)
  }
}

