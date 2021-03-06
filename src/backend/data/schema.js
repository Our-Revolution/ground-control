import {
  GraphQLBoolean,
  GraphQLList,
  GraphQLInt,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLSchema,
  GraphQLString,
  GraphQLID,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLScalarType
} from 'graphql'

import {
  connectionArgs,
  connectionDefinitions,
  connectionFromArray,
  fromGlobalId,
  globalIdField,
  mutationWithClientMutationId,
  nodeDefinitions,
} from 'graphql-relay'

import moment from 'moment-timezone'
import Promise from 'bluebird'
import Maestro from '../maestro'
import url from 'url'
import TZLookup from 'tz-lookup'
import BSDClient from '../bsd-instance'
import {BSDValidationError, BSDExistsError} from '../bsd'
import phoneFormatter from 'phone-formatter'
import knex from './knex'
import humps from 'humps'
import log from '../log'
import MG from '../mail'
import rq from 'request-promise'


const Mailgun        = new MG(process.env.MAILGUN_KEY, process.env.MAILGUN_DOMAIN)
const EVERYONE_GROUP = 'everyone'

class GraphQLError extends Error {
  constructor(errorObject) {
    let message = JSON.stringify(errorObject)
    super(message)

    this.name = 'GraphQLError',
      this.message = message,
      Error.captureStackTrace(this, this.constructor.name)
  }
}

function activeCallAssignments(query) {
  return query.where(function () {
    this.where('end_dt', '>', moment().add(1, 'days').toDate())
      .orWhere('end_dt', null)
  })
}

function inactiveCallAssignments(query) {
  return query
    .where('end_dt', '<', moment().add(1, 'days').toDate())
}

function interpretDateAsUTC(date) {
  return moment.tz(moment(date).format('YYYY-MM-DD HH:mm:ss'), 'UTC').toDate()
}

function authRequired(session) {
  if (!session.user) {
    throw new GraphQLError({
      status: 401,
      message: 'You must login to access that resource.'
    })
  }
}

function adminRequired(session) {
  authRequired(session)
  if (!session.user || !session.user.is_admin) {
    throw new GraphQLError({
      status: 403,
      message: 'You are not authorized to access that resource.'
    })
  }
}

function superuserRequired(session) {
  authRequired(session)
  if (!session.user || !session.user.is_superuser) {
    throw new GraphQLError({
      status: 403,
      message: 'You are not authorized to access that resource.'
    })
  }
}

// We should move these into model-helpers or something
function modelFromBSDResponse(BSDObject, type) {
  let modelKeys = {
    'bsd_surveys': ['signup_form_id', 'signup_form_slug', 'modified_dt', 'create_dt'],
    'bsd_groups': ['cons_group_id', 'name', 'description', 'modified_dt', 'create_dt'],
    'bsd_survey_fields': ['signup_form_field_id', 'modified_dt', 'create_dt', 'signup_form_id', 'format', 'label', 'display_order', 'is_shown', 'is_required', 'description']
  }
  let keys      = modelKeys[type]
  let model     = {}
  keys.forEach((key) => model[key] = BSDObject[key])
  return model;
}

function eventFieldFromAPIField(field) {

  let mapFields = {
    'id': 'eventId',
    'hostId': 'creatorConsId',
    'startDate': 'startDt',
    'createDate': 'createDt',
    'localTimezone': 'startTz',
    'venueState': 'venueStateCd'
  }

  let newFieldName = field;

  Object.keys(mapFields).forEach((key) => {
      if (field === key)
        newFieldName = mapFields[key]
    }
  )

  return humps.decamelize(newFieldName);
}

function eventFromAPIFields(fields) {
  let event = {}
  Object.keys(fields).forEach((fieldName) => {
    let newFieldName    = eventFieldFromAPIField(fieldName)
    event[newFieldName] = fields[fieldName]

    if (newFieldName === 'start_dt')
      event[newFieldName] = event[newFieldName].toISOString()
  })

  let idFields = ['event_id', 'creator_cons_id', 'event_type_id'];
  idFields.forEach((field) => {
    if (event[field]) {
      event[field] = fromGlobalId(event[field]).id
    }
  })

  return event
}

async function getPrimaryEmail(person, transaction) {
  let query = knex('bsd_emails')
    .where({
      is_primary: true,
      cons_id: person.cons_id
    })
    .select('email')
    .first()

  if (transaction)
    query = query.transacting(transaction)

  let emails = await query
  return emails ? emails.email : null
}

async function getPrimaryAddress(person, transaction) {
  let query = knex('bsd_addresses')
    .where({
      is_primary: true,
      cons_id: person.cons_id
    })
    .first()
  if (transaction)
    query = query.transacting(transaction)
  return query
}

async function getPrimaryPhone(person, transaction) {
  let query = knex('bsd_phones')
    .where({
      is_primary: true,
      cons_id: person.cons_id
    })
    .select('phone')
    .first()

  if (transaction)
    query = query.transacting(transaction)

  let phones = await query
  return phones ? phones.phone : null;
}

const SharedListContainer = {
  id: 1,
  _type: 'list_container'
}

async function addType(query) {
  let table     = query._single.tablename
  let results   = await query
  results._type = table;
  return results
}

let {nodeInterface, nodeField} = nodeDefinitions(
  (globalId) => {
    let {type, id} = fromGlobalId(globalId)
    if (type === 'Call')
      return addType(knex('bsd_calls').where('id', id))
    if (type === 'Person')
      return addType(knex('bsd_people').where('cons_id', id))
    if (type === 'CallAssignment')
      return addType(knex('bsd_call_assignments').where('id', id))
    if (type === 'Survey')
      return addType(knex('gc_bsd_surveys').where('id', id))
    if (type === 'EventFile')
      return addType(knex('event_files').where('id', id))
    if (type === 'EventFileType')
      return addType(knex('event_file_types').where('id', id))
    if (type === 'EventType')
      return addType(knex('bsd_event_types').where('event_type_id', id))
    if (type === 'Event')
      return addType(knex('bsd_events').where('event_id', id))
    if (type === 'User')
      return addType(knex('users').where('id', id))
    if (type === 'Address')
      return addType(knex('bsd_addresses').where('cons_addr_id', id))
    if (type === 'ListContainer')
      return SharedListContainer
    if (type == 'FastFwdRequest')
      return addType(knex('fast_fwd_request').where('id', id))
    return null
  },
  (obj) => {
    if (obj._type === 'bsd_call_assignments')
      return GraphQLCallAssignment
    if (obj._type === 'bsd_calls')
      return GraphQLCall
    if (obj._type === 'gc_bsd_surveys')
      return GraphQLSurvey
    if (obj._type === 'list_container')
      return GraphQLListContainer
    if (obj._type === 'event_file_types')
      return GraphQLEventFileType
    if (obj._type === 'bsd_event_types')
      return GraphQLEventType
    if (obj._type === 'bsd_events')
      return GraphQLEvent
    if (obj._type === 'bsd_addresses')
      return GraphQLAddress
    if (obj._type == 'users')
      return GraphQLUser
    if (obj._type == 'fast_fwd_request')
      return GraphQLFastFwdRequest
    return null
  }
)

const GraphQLDate = new GraphQLScalarType({
  name: 'Date',
  serialize (value) {
    if (value === null)
      return null
    if (!(value instanceof Date)) {
      throw new Error('Field error: value is not an instance of Date')
    }

    return value.toJSON()
  },
  parseValue (value) {
    const date = new Date(value)

    return date
  },
  parseLiteral (ast) {
    if (ast.kind !== Kind.STRING) {
      throw new GraphQLError('Query error: Can only parse strings to dates but got a: ' + ast.kind, [ast])
    }
    let result = new Date(ast.value)
    if (isNaN(result.getTime())) {
      throw new GraphQLError('Query error: Invalid date', [ast])
    }
    if (ast.value !== result.toJSON()) {
      throw new GraphQLError('Query error: Invalid date format, only accepts: YYYY-MM-DDTHH:MM:SS.SSSZ', [ast])
    }
    return result
  }
})

const addWhere = ({query, property, value, operator='=', method='where'}) => {
  return query[method](property, operator, value)
}

const GraphQLSortDirectionInput = new GraphQLEnumType({
  name: 'GraphQLSortDirection',
  values: {
    ASC: {value: 'asc'},
    DESC: {value: 'desc'}
  }
})

const GraphQLListContainer = new GraphQLObjectType({
  name: 'ListContainer',
  fields: () => ({
    id: globalIdField('ListContainer'),
    eventFileTypes: {
      type: new GraphQLList(GraphQLEventFileType),
      resolve: async(eventFileType, {rootValue}) => {
        return knex('event_file_types')
      }
    },
    eventTypes: {
      type: new GraphQLList(GraphQLEventType),
      resolve: async(eventType, {rootValue}) => {
        return knex('bsd_event_types').orderBy('name', 'ASC')
      }
    },
    events: {
      type: GraphQLEventConnection,
      args: {
        ...connectionArgs,
        eventFilterOptions: {type: GraphQLEventInput},
        hostFilterOptions: {type: GraphQLPersonInput},
        status: {
          type: new GraphQLEnumType({
            name: 'GraphQLEventStatus',
            values: {
              PAST_EVENTS: {value: 'pastEvents'},
              PENDING_APPROVAL: {value: 'pendingApproval'},
              PENDING_REVIEW: {value: 'pendingReview'},
              APPROVED: {value: 'approved'},
              FAST_FWD_REQUEST: {value: 'fastFwdRequest'}
            }
          })
        },
        sortField: {type: GraphQLString},
        sortDirection: {type: GraphQLSortDirectionInput}
      },
      resolve: async(event, {first, eventFilterOptions, hostFilterOptions, status, sortField, sortDirection}, {rootValue}) => {
        let eventFilters       = eventFromAPIFields(eventFilterOptions)
        let convertedSortField = `bsd_events.${eventFieldFromAPIField(sortField)}`

        let events = knex('bsd_events')
          .where(eventFilters)
          .limit(first)

        if (status === 'pastEvents')
          events = events.where('start_dt', '<', new Date())
        else
          events = events.where('start_dt', '>=', new Date())

        if (status === 'pendingReview')
          events = events
            .join('gc_bsd_events', 'bsd_events.event_id', 'gc_bsd_events.event_id')
            .where('gc_bsd_events.pending_review', true)
            .where('bsd_events.flag_approval', false)
        else if (status === 'pendingApproval')
          events = events.where('flag_approval', true)
        else if (status === 'approved')
          events = events.where('flag_approval', false)
        else if (status == 'fastFwdRequest')
          events = events.join('fast_fwd_request', 'bsd_events.event_id', '=', 'fast_fwd_request.event_id')
            .where('flag_approval', false)
            .whereNull('email_sent_dt')

        events = events.where(eventFilters)
          .orderBy(convertedSortField, sortDirection)

        if (Object.keys(hostFilterOptions).length) {
          events          = events.leftJoin('bsd_people', 'bsd_events.creator_cons_id', 'bsd_people.cons_id')
          let hostFilters = humps.decamelizeKeys(hostFilterOptions)

          Object.keys(hostFilters).forEach((key) => {
            if (key === 'email') {
              events = events.join('bsd_emails', 'bsd_events.creator_cons_id', 'bsd_emails.cons_id')
              events = addWhere({query: events, property: `bsd_emails.${key}`, value: hostFilters[key]})
            }
            else if (key === 'phone') {
              events = events.join('bsd_phones', 'bsd_events.creator_cons_id', 'bsd_phones.cons_id')
              events = addWhere({
                query: events,
                property: `bsd_phones.${key}`,
                value: phoneFormatter.format(hostFilters[key], 'NNNNNNNNNN')
              })
            }
            else {
              events = addWhere({query: events, property: `bsd_people.${key}`, value: hostFilters[key]})
            }
          })
        }

        return connectionFromArray(await events, {first})
      }
    },
    people: {
      type: GraphQLPersonConnection,
      args: {
        ...connectionArgs,
        personFilters: {type: GraphQLPersonInput},
        sortField: {type: GraphQLString},
        sortDirection: {type: GraphQLSortDirectionInput}
      },
      resolve: async(root, {first, personFilters, sortField, sortDirection}, {rootValue}) => {
        if (Object.keys(personFilters).length === 0)
          first = 0

        let people = knex('bsd_people')
          .limit(first)

        if (sortField && sortDirection)
          people = people.orderBy(sortField, sortDirection)

        Object.keys(personFilters).forEach((key) => {
          if (key === 'email') {
            people = people.join('bsd_emails', 'bsd_people.cons_id', 'bsd_emails.cons_id')
            people = addWhere({query: people, property: `bsd_emails.${key}`, value: personFilters[key]})
          }
          else if (key === 'phone') {
            people = people.join('bsd_phones', 'bsd_people.cons_id', 'bsd_phones.cons_id')
            people = addWhere({
              query: people,
              property: `bsd_phones.${key}`,
              value: phoneFormatter.format(personFilters[key], 'NNNNNNNNNN')
            })
          }
          else if (key === 'zip') {
            people = people.join('bsd_addresses', 'bsd_people.cons_id', 'bsd_addresses.cons_id')
            people = addWhere({query: people, property: `bsd_addresses.${key}`, value: personFilters[key]})
          }
          else {
            people = addWhere({query: people, property: `bsd_people.${key}`, value: personFilters[key]})
          }
        })

        return connectionFromArray(await people, {first})
      }
    },
    callAssignments: {
      type: GraphQLCallAssignmentConnection,
      args: {
        ...connectionArgs,
        active: {type: GraphQLBoolean}
      },
      resolve: async(root, {first, active}, {rootValue}) => {
        let query = knex('bsd_call_assignments').limit(first)
        if (active === true)
          query = activeCallAssignments(query)
        else if (active === false)
          query = inactiveCallAssignments(query)
        let assignments = await query
        return connectionFromArray(assignments, {first})
      }
    },
  }),
  interfaces: [nodeInterface]
})

const GraphQLUser = new GraphQLObjectType({
  name: 'User',
  description: 'User of ground control',
  fields: () => ({
    id: globalIdField('User'),
    isAdmin: {
      type: GraphQLBoolean,
      resolve: (user) => user.is_admin
    },
    isSuperuser: {
      type: GraphQLBoolean,
      resolve: (user) => user.is_superuser
    },
    email: {type: GraphQLString},
    relatedPerson: {
      type: GraphQLPerson,
      resolve: async(user, _, {rootValue}) => {
        let relatedPerson = await knex('bsd_emails')
          .select('cons_id')
          .where('email', user.email)
          .first()
        return relatedPerson ? rootValue.loaders.bsdPeople.load(relatedPerson.cons_id) : null
      }
    },
    firstName: {
      type: GraphQLString,
      resolve: async(user) => {
        let name = await knex('bsd_emails')
          .select('bsd_people.firstname')
          .innerJoin('bsd_people', 'bsd_emails.cons_id', 'bsd_people.cons_id')
          .where('email', user.email)
          .first()
        if (name)
          return name['firstname']
        return null;
      }
    },
    callAssignments: {
      type: GraphQLCallAssignmentConnection,
      args: {
        ...connectionArgs,
        active: {type: GraphQLBoolean}
      },
      resolve: async(user, {first, active}) => {
        let nullQuery   = knex('bsd_call_assignments')
          .where('caller_group', null)
        let callerQuery = knex('bsd_call_assignments')
          .select('bsd_call_assignments.*')
          .innerJoin('user_user_groups', 'bsd_call_assignments.caller_group', 'user_user_groups.user_group_id')
          .where('user_user_groups.user_id', user.id)
        // This is duplicated code from the other callAssignments resolve method
        if (active === true) {
          nullQuery   = activeCallAssignments(nullQuery)
          callerQuery = activeCallAssignments(callerQuery)
        }
        else if (active === false) {
          nullQuery   = inactiveCallAssignments(nullQuery)
          callerQuery = inactiveCallAssignments(callerQuery)
        }
        let assignmentsQuery = knex.union([
          nullQuery, callerQuery
        ]);
        log.info(`Running call assignment query: ${assignmentsQuery.toString()}`)

        let assignments = await assignmentsQuery

        return connectionFromArray(assignments, {first})
      }
    },
    callsMade: {
      type: GraphQLInt,
      args: {
        forAssignmentId: {type: GraphQLString},
        completed: {type: GraphQLBoolean}
      },
      resolve: async(user, {forAssignmentId, completed}) => {
        let query = knex('bsd_calls').where('caller_id', user.id)

        if (forAssignmentId) {

          let localId = fromGlobalId(forAssignmentId)
          if (localId.type !== 'CallAssignment')
            localId = forAssignmentId
          else
            localId = localId.id

          query = query.where('call_assignment_id', localId)
        }

        if (typeof completed !== 'undefined')
          query = query.where('completed', completed)

        return knex.count(query, 'id')
      }
    },
    intervieweeForCallAssignment: {
      type: GraphQLPerson,
      args: {
        callAssignmentId: {type: GraphQLString}
      },
      resolve: async(user, {callAssignmentId}, {rootValue}) => {

        let localCallAssignmentId = fromGlobalId(callAssignmentId)
        if (localCallAssignmentId.type !== 'CallAssignment')
          localCallAssignmentId = callAssignmentId
        else
          localCallAssignmentId = localCallAssignmentId.id

        await knex('bsd_assigned_calls')
          .where('caller_id', user.id)
          .delete()
        let callAssignment = await rootValue.loaders.bsdCallAssignments.load(localCallAssignmentId)

        // Determine the time zone offsets where it's okay to call.  We only
        // want to call interviewees whose local time is between 9am and 9pm.
        let allOffsets     = [-10, -9, -8, -7, -6, -5, -4]
        let validOffsets   = []
        // So that I can program late at night
        if (process.env.NODE_ENV === 'development')
          validOffsets = allOffsets

        allOffsets.forEach((offset) => {
          let time = moment().utcOffset(offset)

          if (time.hours() >= 9 && time.hours() < 21)
            validOffsets.push(offset)
        })

        if (validOffsets.length === 0)
          return null

        let group = await rootValue.loaders.gcBsdGroups.load(callAssignment.interviewee_group)

        // Determine whom we *shouldn't* call.
        let previousCallsSubquery = knex('bsd_calls')
          .select('interviewee_id')
          // Don't call people we have successfully canvassed
          .where(function () {
            this.where('completed', true)
              .where('call_assignment_id', localCallAssignmentId)
          })
          // Don't call unusable numbers.
          .orWhereIn('reason_not_completed', ['WRONG_NUMBER', 'DISCONNECTED_NUMBER', 'OTHER_LANGUAGE'])
          // If the person wasn't available, wait 24h before calling again.
          .orWhere(function () {
            this.whereIn('reason_not_completed', ['NO_PICKUP', 'CALL_BACK'])
              .where('attempted_at', '>', new Date(new Date() - 24 * 60 * 60 * 1000))
          })
          // Don't call people who rejected this specific assignment.
          .orWhere(function () {
            this.where('call_assignment_id', localCallAssignmentId)
              .where('reason_not_completed', 'NOT_INTERESTED')
          })

        // This is the main query for people we want to call.
        let query = knex.select('bsd_people.cons_id')
        if (group.cons_group_id) {
          query = query
            .from('bsd_person_bsd_groups as bsd_people')
            .where('bsd_people.cons_group_id', group.cons_group_id)
        } else if (group.query && group.query !== EVERYONE_GROUP) {
          query = query
            .from('bsd_person_gc_bsd_groups as bsd_people')
            .where('gc_bsd_group_id', group.id)
        } else {
          query = query.from('bsd_people')
        }

        let assignedCallsSubquery = knex('bsd_assigned_calls')
          .select('interviewee_id')

        query = query
          .join('bsd_phones', 'bsd_people.cons_id', 'bsd_phones.cons_id')
          .join('bsd_addresses', 'bsd_people.cons_id', 'bsd_addresses.cons_id')
          .join('zip_codes', 'zip_codes.zip', 'bsd_addresses.zip')
          .whereNotIn('bsd_people.cons_id', previousCallsSubquery)
          .whereNotIn('bsd_people.cons_id', assignedCallsSubquery)
          .whereIn('zip_codes.timezone_offset', validOffsets)
          .where('bsd_phones.is_primary', true)
          .where('bsd_addresses.is_primary', true)
          .limit(1)
          .first()

        // Don't ask the user to call themselves.
        let userAddress = await knex('bsd_emails')
          .select('bsd_emails.cons_id')
          .where('bsd_emails.email', user.email)
          .first()
        if (userAddress)
          query = query.whereNot('bsd_people.cons_id', userAddress.cons_id)

        log.info(`Running query: ${query}`)

        let person    = await query
        let timestamp = new Date()

        if (person) {
          // Do this check again to avoid race conditions
          let assignedCall = await knex('bsd_assigned_calls').where({
            'caller_id': user.id,
            'call_assignment_id': localCallAssignmentId
          }).first()

          if (assignedCall)
            return rootValue.loaders.bsdPeople.load(assignedCall.interviewee_id)

          await knex('bsd_assigned_calls')
            .insert({
              caller_id: user.id,
              interviewee_id: person.cons_id,
              call_assignment_id: localCallAssignmentId,
              create_dt: timestamp,
              modified_dt: timestamp
            })

          return rootValue.loaders.bsdPeople.load(person.cons_id)
        }

        return null
      }
    }
  }),
  interfaces: [nodeInterface]
})

const GraphQLAddress = new GraphQLObjectType({
  name: 'Address',
  description: 'An address',
  fields: () => ({
    id: globalIdField('Address', (obj) => obj.cons_addr_id),
    personId: {
      type: GraphQLInt,
      resolve: (address) => address.cons_id
    },
    addr1: {type: GraphQLString},
    addr2: {type: GraphQLString},
    addr3: {type: GraphQLString},
    city: {type: GraphQLString},
    state: {
      type: GraphQLString,
      resolve: (address) => address.state_cd
    },
    country: {
      type: GraphQLString,
      resolve: (address) => address.country
    },
    zip: {type: GraphQLString},
    latitude: {type: GraphQLFloat},
    longitude: {type: GraphQLFloat},
    localUTCOffset: {
      type: GraphQLInt,
      resolve: async(address) => {
        let tz = TZLookup(address.latitude, address.longitude)
        tz     = moment().tz(tz);
        return tz ? tz.utcOffset() : 0
      }
    },
    people: {
      type: new GraphQLList(GraphQLPerson),
      resolve: async(address, _, {rootValue}) => {
        return knex('bsd_people').where('cons_id', address.cons_id)
      }
    }
  }),
  interfaces: [nodeInterface]
})

const GraphQLPerson = new GraphQLObjectType({
  name: 'Person',
  description: 'A person.',
  fields: () => ({
    id: globalIdField('Person', (obj) => obj.cons_id),
    prefix: {type: GraphQLString},
    firstName: {
      type: GraphQLString,
      resolve: (person) => person.firstname
    },
    middleName: {
      type: GraphQLString,
      resolve: (person) => person.middlename
    },
    lastName: {
      type: GraphQLString,
      resolve: (person) => person.lastname
    },
    suffix: {type: GraphQLString},
    gender: {type: GraphQLString},
    birthDate: {
      type: GraphQLDate,
      resolve: (person) => interpretDateAsUTC(person.birth_dt)
    },
    title: {type: GraphQLString},
    employer: {type: GraphQLString},
    occupation: {type: GraphQLString},
    phone: {
      type: GraphQLString,
      resolve: async(person, _, {rootValue}) => {
        return getPrimaryPhone(person)
      }
    },
    email: {
      type: GraphQLString,
      resolve: async(person) => {
        return getPrimaryEmail(person)
      }
    },
    address: {
      type: GraphQLAddress,
      resolve: async(person, _, {rootValue}) => {
        return getPrimaryAddress(person)
      }
    },
    lastCalled: {
      type: GraphQLString,
      resolve: async(person) => {
        let lastCall = await knex('bsd_calls')
          .where('interviewee_id', person.cons_id)
          .orderBy('create_dt', 'desc')
          .first()

        return lastCall ? lastCall.create_dt : null
      }
    },
    nearbyEvents: {
      type: new GraphQLList(GraphQLEvent),
      args: {
        within: {type: GraphQLInt},
        type: {type: GraphQLString}
      },
      resolve: async(person, {within, type}, {rootValue}) => {
        let address          = await getPrimaryAddress(person);
        let boundingDistance = within / 69
        let eventTypes       = null
        if (type) {
          eventTypes = await knex('bsd_event_types')
            .where('name', 'ilike', `%${type}%`)
            .select('event_type_id')
        }

        let query = knex('bsd_events')
          .whereRaw(`ST_DWithin(bsd_events.geom, st_transform(st_setsrid(st_makepoint(${address.longitude}, ${address.latitude}), 4326), 900913), ${within * 1000})`)
          .where('start_dt', '>', new Date())
          .where('flag_approval', false)
          .whereNot('is_searchable', 0)

        if (eventTypes)
          query = query.whereIn('event_type_id', eventTypes.map((type) => type.event_type_id))

        return query
      }
    },
    hostedEvents: {
      type: new GraphQLList(GraphQLEvent),
      resolve: async (person, {rootValue}) => {
        return knex('bsd_events')
          .where('creator_cons_id', person.cons_id)
          .orderBy('start_dt', 'asc')
      }
    }
  }),
  interfaces: [nodeInterface]
})

const GraphQLPersonInput = new GraphQLInputObjectType({
  name: 'PersonInput',
  fields: {
    id: {type: GraphQLString},
    prefix: {type: GraphQLString},
    firstname: {type: GraphQLString},
    middlename: {type: GraphQLString},
    lastname: {type: GraphQLString},
    suffix: {type: GraphQLString},
    gender: {type: GraphQLString},
    birthDate: {type: GraphQLDate},
    title: {type: GraphQLString},
    employer: {type: GraphQLString},
    occupation: {type: GraphQLString},
    phone: {type: GraphQLString},
    email: {type: GraphQLString},
    city: {type: GraphQLString},
    state: {type: GraphQLString},
    zip: {type: GraphQLString}
  }
})

const GraphQLCall = new GraphQLObjectType({
  name: 'Call',
  description: 'A call between a user and a person',
  fields: () => ({
    id: globalIdField('Call'),
    attemptedAt: {type: GraphQLString},
    leftVoicemail: {type: GraphQLBoolean},
    sentText: {type: GraphQLBoolean},
    completed: {type: GraphQLBoolean},
    reasonNotCompleted: {type: GraphQLString},
    caller: {type: GraphQLUser},
    interviewee: {type: GraphQLPerson},
    callAssignment: {type: GraphQLCallAssignment}
  })
})

const GraphQLEventFile = new GraphQLObjectType({
  name: 'EventFile',
  description: 'An event file',
  fields: () => ({
    id: globalIdField('EventFile', (obj) => obj.id),
    type: {
      type: GraphQLEventFileType,
      resolve: async (file, _, {rootValue}) => rootValue.loaders.eventFileTypes.load(file.event_file_type_id)
    },
    uploader: {
      type: GraphQLUser,
      resolve: async (file) => await knex('users').where('id', file.uploader_id).first()
    },
    mimeType: {
      type: GraphQLString,
      resolve: (file) => file.mime_type
    },
    name: { type: GraphQLString },
    notes: { type: GraphQLString },
    url: {
      type: GraphQLString,
      resolve: (file) => `https://${process.env.S3_BUCKET}.s3.amazonaws.com/${encodeURIComponent(file.s3_key)}`
    },
    modifiedDate: {
      type: GraphQLDate,
      resolve: (file) => interpretDateAsUTC(file.modified_dt)
    }
  })
})

const GraphQLEventFileType = new GraphQLObjectType({
  name: 'EventFileType',
  description: 'An event file type',
  fields: () => ({
    id: globalIdField('EventFileType', (obj) => obj.id),
    slug: {type: GraphQLString},
    name: {type: GraphQLString},
    description: {type: GraphQLString}
  })
})

const { connectionType: GraphQLEventFileTypeConnection } = connectionDefinitions({
  name: 'EventFileType',
  nodeType: GraphQLEventFileType
})

const GraphQLEventType = new GraphQLObjectType({
  name: 'EventType',
  description: 'An event type',
  fields: () => ({
    id: globalIdField('EventType', (obj) => obj.event_type_id),
    name: {type: GraphQLString},
    description: {type: GraphQLString}
  })
})

let {
      connectionType: GraphQLEventTypeConnection,
    } = connectionDefinitions({
  name: 'EventType',
  nodeType: GraphQLEventType
})

const GraphQLEvent = new GraphQLObjectType({
  name: 'Event',
  description: 'An event',
  fields: () => ({
    id: globalIdField('Event', (obj) => obj.event_id),
    eventIdObfuscated: {
      type: GraphQLString,
      resolve: (event) => event.event_id_obfuscated
    },
    eventIdUnObfuscated: {
      type: GraphQLInt,
      resolve: (event) => event.event_id
    },
    isOfficial: {
      type: GraphQLBoolean,
      resolve: (event) => event.is_official
    },
    creatorName: {
      type: GraphQLString,
      resolve: (event) => event.creator_name
    },
    host: {
      type: GraphQLPerson,
      resolve: async(event, _, {rootValue}) => rootValue.loaders.bsdPeople.load(event.creator_cons_id)
    },
    eventType: {
      type: GraphQLEventType,
      resolve: (event, _, {rootValue}) => rootValue.loaders.bsdEventTypes.load(event.event_type_id)
    },
    flagApproval: {
      type: GraphQLBoolean,
      resolve: (event) => event.flag_approval
    },
    name: {type: GraphQLString},
    description: {type: GraphQLString},
    venueName: {
      type: GraphQLString,
      resolve: (event) => event.venue_name
    },
    venueZip: {
      type: GraphQLString,
      resolve: (event) => event.venue_zip
    },
    venueCity: {
      type: GraphQLString,
      resolve: (event) => event.venue_city
    },
    venueState: {
      type: GraphQLString,
      resolve: (event) => event.venue_state_cd
    },
    venueAddr1: {
      type: GraphQLString,
      resolve: (event) => event.venue_addr1
    },
    venueAddr2: {
      type: GraphQLString,
      resolve: (event) => event.venue_addr2
    },
    venueCountry: {
      type: GraphQLString,
      resolve: (event) => event.venue_country
    },
    venueDirections: {
      type: GraphQLString,
      resolve: (event) => event.venue_directions
    },
    localTimezone: {
      type: GraphQLString,
      resolve: (event) => {
        let zone = moment.tz.zone(event.start_tz)
        return zone ? zone.name : null;
      }
    },
    localUTCOffset: {
      type: GraphQLInt,
      resolve: (event) => {
        let tz = moment().tz(event.start_tz);
        return tz ? tz.utcOffset() : 0
      }
    },
    startDate: {
      type: GraphQLDate,
      resolve: (event) => {
        return interpretDateAsUTC(event.start_dt)
      }
    },
    createDate: {
      type: GraphQLDate,
      resolve: (event) => {
        return interpretDateAsUTC(event.create_dt)
      }
    },
    duration: {type: GraphQLInt},
    capacity: {type: GraphQLInt},
    latitude: {type: GraphQLFloat},
    longitude: {type: GraphQLFloat},
    attendeeVolunteerShow: {
      type: GraphQLInt,
      resolve: (event) => event.attendee_volunteer_show
    },
    attendeeVolunteerMessage: {
      type: GraphQLString,
      resolve: (event) => event.attendee_volunteer_message
    },
    isSearchable: {
      type: GraphQLInt,
      resolve: (event) => event.is_searchable
    },
    publicPhone: {
      type: GraphQLBoolean,
      resolve: (event) => event.public_phone
    },
    contactPhone: {
      type: GraphQLString,
      resolve: (event) => event.contact_phone
    },
    hostReceiveRsvpEmails: {
      type: GraphQLBoolean,
      resolve: (event) => event.host_receive_rsvp_emails
    },
    rsvpUseReminderEmail: {
      type: GraphQLBoolean,
      resolve: (event) => event.rsvp_use_reminder_email
    },
    rsvpEmailReminderHours: {
      type: GraphQLInt,
      resolve: (event) => event.rsvp_email_reminder_hours
    },
    link: {
      type: GraphQLString,
      resolve: (event) => url.resolve(`https://${process.env.BSD_HOST}`, `/page/event/detail/${event.event_id_obfuscated}`)
    },
    attendeesCount: {
      type: GraphQLInt,
      resolve: async (event) => {
        const count = await knex('bsd_event_attendees').where('event_id', event.event_id).count('event_attendee_id');
        return count[0].count
      }
    },
    attendees: {
      type: new GraphQLList(GraphQLPerson),
      resolve: async (event, _, {rootValue}) => {
        const attendeeIds = await knex('bsd_event_attendees').select('attendee_cons_id', 'event_id').where('event_id', event.event_id)
         let attendees = []
         for (let i = 0; i < attendeeIds.length; i++) {
         let attendee = await rootValue.loaders.bsdPeople.load(attendeeIds[i].attendee_cons_id)
         attendees.push(attendee)
         }
         return attendees
      }
    },
    files: {
      type: new GraphQLList(GraphQLEventFile),
      resolve: async (event, _, {rootValue}) => {
        const fileIds = await knex('event_files').select('id').where('event_id', event.event_id)
        let files = []
        for (let i = 0; i < fileIds.length; i++) {
          const file = await rootValue.loaders.eventFiles.load(fileIds[i].id)
          files.push(file)
        }
        return files
      }
    },
    relatedCallAssignment: {
      type: GraphQLCallAssignment,
      resolve: async (event, _, {rootValue}) => {
        const assignment = await knex('bsd_call_assignments')
          .select('bsd_call_assignments.id')
          .join('gc_bsd_events', 'bsd_call_assignments.id', 'gc_bsd_events.turn_out_assignment')
          .where('gc_bsd_events.event_id', event.event_id)
          .first()
        if (assignment !== undefined)
          return rootValue.loaders.bsdCallAssignments.load(assignment.id)
        else
          return null
      }
    },
    nearbyPeople: {
      type: new GraphQLList(GraphQLPerson),
      resolve: async (event, _, {rootValue}) => {
        let maxRadius   = 50000;
        let radius      = 1000;
        let backoff     = 1000;
        let foundPeople = [];

        while (foundPeople.length < 500 && radius <= maxRadius) {
          let foundConsIds = foundPeople.map((person) => person.cons_id)
          let query        = knex('bsd_addresses')
            .distinct('bsd_emails.email')
            .select('bsd_people.*')
            .join('bsd_people', 'bsd_addresses.cons_id', 'bsd_people.cons_id')
            .join('bsd_emails', 'bsd_people.cons_id', 'bsd_emails.cons_id')
            .leftJoin('communications', 'bsd_people.cons_id', 'communications.person_id')
            .innerJoin('bsd_subscriptions', 'bsd_people.cons_id', 'bsd_subscriptions.cons_id')
            .where('bsd_addresses.is_primary', true)
            .where('bsd_emails.is_primary', true)
            .where('bsd_subscriptions.isunsub', false)
            .whereNotIn('bsd_people.cons_id', foundConsIds)
            .whereRaw(`st_dwithin(bsd_addresses.geom, '${event.geom}', ${radius})`)
            .whereNull('communications.id')
            .limit(500)
          log.info(`Running query: ${query.toString()}`)
          let people  = await query
          foundPeople = foundPeople.concat(people)
          radius += backoff;
          if (radius === 15000)
            backoff = 5000;
        }
        return foundPeople.slice(0, 500)
      }
    },
    fastFwdRequest: {
      type: GraphQLFastFwdRequest,
      resolve: async (event) => {
        let req = await knex.table('fast_fwd_request')
          .where('event_id', event['event_id'])
        return humps.camelizeKeys(req[0])
      }
    }
  }),
  interfaces: [nodeInterface]
})

let {
      connectionType: GraphQLEventConnection,
    } = connectionDefinitions({
  name: 'Event',
  nodeType: GraphQLEvent
})

let {
      connectionType: GraphQLPersonConnection,
    } = connectionDefinitions({
  name: 'Person',
  nodeType: GraphQLPerson
})

const GraphQLCallAssignment = new GraphQLObjectType({
  name: 'CallAssignment',
  description: 'A mass calling assignment',
  fields: () => ({
    id: globalIdField('CallAssignment'),
    name: {type: GraphQLString},
    instructions: {type: GraphQLString},
    endDate: {
      type: GraphQLDate,
      resolve: (assignment) => {
        return moment(assignment.end_dt).toDate()
      }
    },
    survey: {
      type: GraphQLSurvey,
      resolve: (assignment, _, {rootValue}) => rootValue.loaders.gcBsdSurveys.load(assignment.gc_bsd_survey_id)
    },
    renderer: {type: GraphQLString},
    callsMade: {
      type: GraphQLInt,
      resolve: async(callAssignment) => {
        return knex.count(knex('bsd_calls').where('call_assignment_id', callAssignment.id), 'id')
      }
    },
    relatedEvent: {
      type: GraphQLEvent,
      resolve: async(assignment, _, {rootValue}) => {
        let eventId = await knex('gc_bsd_events')
          .join('bsd_events', 'gc_bsd_events.event_id', 'bsd_events.event_id')
          .where('gc_bsd_events.turn_out_assignment', assignment.id)
          .select('bsd_events.event_id_obfuscated')
          .first()

        return eventId ? rootValue.loaders.bsdEvents.load(eventId.event_id_obfuscated) : null
      }
    },
    query: {
      type: GraphQLString,
      resolve: async(assignment, _, {rootValue}) => {
        let group = await rootValue.loaders.gcBsdGroups.load(assignment.interviewee_group)
        if (group.cons_group_id) {
          return 'BSD Constituent Group: ' + group.cons_group_id
        }
        else
          return group.query
      }
    }
  }),
  interfaces: [nodeInterface]
})

let {
      connectionType: GraphQLCallAssignmentConnection,
    } = connectionDefinitions({
  name: 'CallAssignment',
  nodeType: GraphQLCallAssignment
})

const GraphQLSurvey = new GraphQLObjectType({
  name: 'Survey',
  description: 'A survey to be filled out by a person',
  fields: () => ({
    id: globalIdField('Survey'),
    fullURL: {
      type: GraphQLString,
      resolve: async(survey, _, {rootValue}) => {
        log.info(`Getting slug for survey ${survey.signup_form_id}`)
        let underlyingSurvey = await rootValue.loaders.bsdSurveys.load(survey.signup_form_id)
        let slug             = underlyingSurvey.signup_form_slug
        return url.resolve('https://' + process.env.BSD_HOST, '/page/s/' + slug)
      }
    },
  }),
  interfaces: [nodeInterface]
})

const GraphQLEventInput = new GraphQLInputObjectType({
  name: 'EventInput',
  fields: {
    id: {type: GraphQLString},
    eventIdObfuscated: {type: GraphQLString},
    isOfficial: {type: GraphQLBoolean},
    eventTypeId: {type: GraphQLString},
    creatorName: {type: GraphQLString},
    hostId: {type: GraphQLString},
    flagApproval: {type: GraphQLBoolean},
    name: {type: GraphQLString},
    description: {type: GraphQLString},
    venueName: {type: GraphQLString},
    venueZip: {type: GraphQLString},
    venueCity: {type: GraphQLString},
    venueState: {type: GraphQLString},
    venueAddr1: {type: GraphQLString},
    venueAddr2: {type: GraphQLString},
    venueCountry: {type: GraphQLString},
    venueDirections: {type: GraphQLString},
    localTimezone: {type: GraphQLString},
    createDate: {type: GraphQLDate},
    startDate: {type: GraphQLDate}, // This should be CustomGraphQLDateType, but it's broken until a PR gets merged in
                                    // to the graphql-custome-datetype repo
    duration: {type: GraphQLInt},
    latitude: {type: GraphQLFloat},
    longitude: {type: GraphQLFloat},
    capacity: {type: GraphQLInt},
    attendeeVolunteerShow: {type: GraphQLInt},
    attendeeVolunteerMessage: {type: GraphQLString},
    isSearchable: {type: GraphQLInt},
    publicPhone: {type: GraphQLBoolean},
    contactPhone: {type: GraphQLString},
    hostReceiveRsvpEmails: {type: GraphQLBoolean},
    rsvpUseReminderEmail: {type: GraphQLBoolean},
    rsvpEmailReminderHours: {type: GraphQLInt},
  }
})

const GraphQLEditEvents = mutationWithClientMutationId({
  name: 'EditEvents',
  inputFields: {
    events: {type: new GraphQLNonNull(new GraphQLList(GraphQLEventInput))}
  },
  outputFields: {
    message: {
      type: GraphQLString,
      resolve: ({message}) => message
    },
    listContainer: {
      type: GraphQLListContainer,
      resolve: ({events}) => SharedListContainer
    }
  },
  mutateAndGetPayload: async({events}, {rootValue}) => {
    adminRequired(rootValue)
    let params         = events.map((event) => {
      return eventFromAPIFields(event)
    })
    let count          = params.length;
    let updateErrors   = [];
    let reviewedEvents = [];
    let message        = `${events.length} Event${(events.length > 1) ? 's' : ''} Updated`;

    for (let index = 0; index < count; index++) {
      let newEventData = params[index]

      let event = await knex('bsd_events')
        .where('event_id', newEventData.event_id)
        .first()

      // Mark event reviewed if no longer pending approval
      if (event.flag_approval === true && newEventData.flag_approval === false)
        reviewedEvents.push(Number(event.event_id))

      log.info(`Event ${event.event_id_obfuscated} updated by ${rootValue.user.email}`)
      log.info('New Event Data:', newEventData)
      log.info('Old Event Data:', event)

      event = {
        ...event,
        ...newEventData
      }

      // Delete empty event data
      Object.keys(event).forEach((key) => {
        if (event[key] === '') {
          delete event[key]
        }
      })

      // Require phone number for RSVPs
      const eventIdsRequiringPhone = new Set([22, 31, 32, 39, 41, 45])
      if (eventIdsRequiringPhone.has(Number(event['event_type_id']))) {
        event['attendee_require_phone'] = 1
      }

      // Delete event host address fields (API calls fail if these are incomplete so just remove them all for now)
      const hostAddressFields = [
        'host_addr_addressee',
        'host_addr_addr1',
        'host_addr_addr2',
        'host_addr_zip',
        'host_addr_city',
        'host_addr_state_cd',
        'host_addr_country'
      ]
      hostAddressFields.forEach((field) => delete event[field])

      try {
        log.info('Merged Event Data:', event)
        await BSDClient.updateEvent(event)
      }
      catch (ex) {
        log.error(ex)
        if (ex instanceof BSDValidationError) {
          updateErrors.push(`${event.event_id_obfuscated}: ${ex.message}`)
          continue
        }
        else if (ex instanceof BSDExistsError) {
          await knex('bsd_events')
            .whereIn('event_id', event.event_id)
            .del()
          log.info(`Deleted event ${event.event_id_obfuscated}`)
          continue
        }
        else {
          log.error(`Unknown exception when updating event ${JSON.stringify(event)}`)
          updateErrors.push(`${event.event_id_obfuscated}: ${ex.message}`)
          log.error(ex)
        }
      }

      await knex('bsd_events')
        .where('event_id', event.event_id)
        .update({
          ...event,
          modified_dt: new Date()
        })
    }

    if (updateErrors.length > 0) {
      message = updateErrors.join(', ')
    }

    if (reviewedEvents.length > 0)
      await markEventsReviewed(reviewedEvents)

    return {events, message}
  }
})

const GraphQLDeleteEvents = mutationWithClientMutationId({
  name: 'DeleteEvents',
  inputFields: {
    ids: {type: new GraphQLNonNull(new GraphQLList(GraphQLString))},
    hostMessage: {type: GraphQLString}
  },
  outputFields: {
    listContainer: {
      type: GraphQLListContainer,
      resolve: () => SharedListContainer
    }
  },
  mutateAndGetPayload: async({ids, hostMessage}, {rootValue}) => {
    adminRequired(rootValue)
    if (!rootValue.user.is_superuser && ids.length !== 1)
      throw new GraphQLError({
        status: 403,
        message: 'Your account is only authorized to delete one event at a time.'
      })
    let localIds = ids.map((id) => fromGlobalId(id).id)
    await BSDClient.deleteEvents(localIds)

    log.info(`${localIds.length} event(s) deleted by ${rootValue.user.email}: ${localIds.join(', ')}`)

    try {
      if (hostMessage.length > 0) {
        const hostIds     = await knex('bsd_events').select('creator_cons_id').whereIn('event_id', localIds);
        const attendeeIds = await knex('bsd_event_attendees').select('attendee_cons_id', 'event_id').whereIn('event_id', localIds);
        const events      = await knex('bsd_events').select('event_id_obfuscated', 'event_id', 'name', 'start_dt').whereIn('event_id', localIds);
        log.info(attendeeIds, events);

        for (let i = 0; i < hostIds.length; i++) {
          let host      = await rootValue.loaders.bsdPeople.load(hostIds[i].creator_cons_id);
          let recipient = await getPrimaryEmail(host);
          if (recipient)
            await Mailgun.sendEventDeletionNotification({recipient, message: hostMessage, events})
        }

        for (let i = 0; i < attendeeIds.length; i++) {
          let attendee  = await rootValue.loaders.bsdPeople.load(attendeeIds[i].attendee_cons_id);
          let recipient = await getPrimaryEmail(attendee);
          if (recipient)
            await Mailgun.sendEventDeletionNotification({recipient, message: hostMessage, events})
        }

        await Mailgun.sendEventDeletionNotification({recipient: rootValue.user.email, message: hostMessage, events})
      }
    }
    catch (ex) {
      log.error('Could not send deletion email')
      log.error(ex)
    }

    await knex('bsd_events')
      .whereIn('event_id', localIds)
      .del()
    await markEventsReviewed(localIds)

    return localIds
  }
})

const GraphQLEmailHostAttendees = mutationWithClientMutationId({
  name: 'EmailHostAttendees',
  inputFields: {
    ids: {type: new GraphQLNonNull(new GraphQLList(GraphQLString))},
    replyTo: {type: GraphQLString},
    bcc: {type: new GraphQLList(GraphQLString)},
    subject: {type: GraphQLString},
    message: {type: GraphQLString},
    target: {
      type: new GraphQLEnumType({
        name: 'GraphQLEmailTarget',
        values: {
          HOST: {value: 'host'},
          ATTENDEES: {value: 'attendees'},
          HOST_AND_ATTENDEES: {value: 'hostAndAttendees'}
        }
      })
    },
  },
  outputFields: {
    success: {
      type: GraphQLListContainer,
      resolve: ({success}) => success
    },
    message: {
      type: GraphQLListContainer,
      resolve: ({message}) => message
    }
  },
  mutateAndGetPayload: async({ids, replyTo, bcc, subject, message, target}, {rootValue}) => {
    adminRequired(rootValue)
    let localIds   = ids.map((id) => fromGlobalId(id).id)
    let recipients = []

    log.info(`${localIds.length} event email(s) sent by ${rootValue.user.email}: ${localIds.join(', ')}`)

    if (target === 'host' || target === 'hostAndAttendees') {
      const hostIds = await knex('bsd_events').select('creator_cons_id').whereIn('event_id', localIds);

      for (let i = 0; i < hostIds.length; i++) {
        let host      = await rootValue.loaders.bsdPeople.load(hostIds[i].creator_cons_id);
        let recipient = await getPrimaryEmail(host)
        recipients.push(recipient)
      }
    }
    if (target === 'attendees' || target === 'hostAndAttendees') {
      const attendeeIds = await knex('bsd_event_attendees').select('attendee_cons_id', 'event_id').whereIn('event_id', localIds);

      for (let i = 0; i < attendeeIds.length; i++) {
        let attendee  = await rootValue.loaders.bsdPeople.load(attendeeIds[i].attendee_cons_id);
        let recipient = await getPrimaryEmail(attendee)
        if (recipient)
          recipients.push(recipient)
      }
    }

    const email = {
      from: 'info@ourrevolution.com',
      'h:Reply-To': replyTo,
      to: 'info@ourrevolution.com',
      bcc: [...bcc, ...recipients],
      subject: subject,
      text: message
    }

    const result = await Mailgun.send(email)

    return {success: true, message: `Message sent to ${recipients.length} recipients.`}
  }
})

const markEventsReviewed  = async(ids, pendingReview = false) => {
  await knex('gc_bsd_events')
    .whereIn('event_id', ids)
    .update('pending_review', pendingReview)
  return ids
}
const GraphQLReviewEvents = mutationWithClientMutationId({
  name: 'ReviewEvents',
  inputFields: {
    ids: {type: new GraphQLNonNull(new GraphQLList(GraphQLString))},
    pendingReview: {type: GraphQLBoolean}
  },
  outputFields: {
    listContainer: {
      type: GraphQLListContainer,
      resolve: () => SharedListContainer
    }
  },
  mutateAndGetPayload: async({ids, pendingReview}, {rootValue}) => {
    adminRequired(rootValue)
    const localIds = ids.map((id) => fromGlobalId(id).id)
    log.info(`${localIds.length} event(s) marked reviewed by ${rootValue.user.email}: ${localIds.join(', ')}`)
    return await markEventsReviewed(localIds, pendingReview)
  }
})

const GraphQLSaveEventFile = mutationWithClientMutationId({
  name: 'SaveEventFile',
  inputFields: {
    fileName: { type: new GraphQLNonNull(GraphQLString) },
    fileTypeSlug: { type: new GraphQLNonNull(GraphQLString) },
    mimeType: { type: new GraphQLNonNull(GraphQLString) },
    key: { type: new GraphQLNonNull(GraphQLString) },
    notes: { type: GraphQLString },
    sourceEventId: { type: new GraphQLNonNull(GraphQLString) },
  },
  outputFields: {
    event: { type: GraphQLEvent }
  },
  mutateAndGetPayload: async ({fileName, fileTypeSlug, mimeType, key, notes, sourceEventId}, {rootValue}) => {
    const userId = rootValue.user.id
    const fileType = await knex('event_file_types')
      .where('slug', fileTypeSlug)
      .first()

    const event = await rootValue.loaders.bsdEvents.load(sourceEventId)
    const file = await knex.insertAndFetch('event_files', {
      event_file_type_id: fileType.id,
      event_id: Number(event.event_id),
      uploader_id: userId,
      mime_type: mimeType,
      name: fileName,
      notes,
      s3_key: key
    })

    return event
  }
})

const GraphQLSubmitCallSurvey = mutationWithClientMutationId({
  name: 'SubmitCallSurvey',
  inputFields: {
    callAssignmentId: {type: new GraphQLNonNull(GraphQLString)},
    intervieweeId: {type: new GraphQLNonNull(GraphQLString)},
    completed: {type: new GraphQLNonNull(GraphQLBoolean)},
    leftVoicemail: {type: GraphQLBoolean},
    sentText: {type: GraphQLBoolean},
    reasonNotCompleted: {type: GraphQLString},
    surveyFieldValues: {type: new GraphQLNonNull(GraphQLString)}
  },
  outputFields: {
    currentUser: {
      type: GraphQLUser,
    }
  },
  mutateAndGetPayload: async({callAssignmentId, intervieweeId, completed, leftVoicemail, sentText, reasonNotCompleted, surveyFieldValues}, {rootValue}) => {
    authRequired(rootValue)

    let caller             = rootValue.user
    let localIntervieweeId = fromGlobalId(intervieweeId).id

    let localCallAssignmentId = fromGlobalId(callAssignmentId)
    if (localCallAssignmentId.type !== 'CallAssignment')
      localCallAssignmentId = callAssignmentId
    else
      localCallAssignmentId = localCallAssignmentId.id

    return knex.transaction(async(trx) => {
      // To ensure that the assigned call exists
      let assignedCall = await knex('bsd_assigned_calls')
        .transacting(trx)
        .where('caller_id', caller.id)
        .where('call_assignment_id', localCallAssignmentId)
        .first()

      if (!assignedCall) {
        throw new Error(`No assigned call found when caller ${caller.id} submitted call survey for interviwee ${localIntervieweeId}`)
      }

      let assignedCallInfo = {
        callerId: assignedCall.caller_id,
        intervieweeId: assignedCall.interviewee_id,
        callAssignmentId: assignedCall.call_assignment_id
      }

      let submittedCallInfo = {
        callerId: caller.id,
        intervieweeId: localIntervieweeId,
        callAssignmentId: localCallAssignmentId
      }

      Object.keys(assignedCallInfo).forEach((key) => {
        if (assignedCallInfo[key] !== submittedCallInfo[key]) {
          throw new Error('Assigned call does not match submitted call info.\n assignedCallInfo:' + JSON.stringify(assignedCallInfo) + '\nsubmittedCallInfo:' + JSON.stringify(submittedCallInfo))
        }
      })

      let callAssignment = await knex('bsd_call_assignments')
        .transacting(trx)
        .where('id', localCallAssignmentId)
        .first()

      let survey = await knex('gc_bsd_surveys')
        .transacting(trx)
        .where('id', callAssignment.gc_bsd_survey_id)
        .first()

      let fieldValues = JSON.parse(surveyFieldValues)

      fieldValues['person'] = await knex('bsd_people')
        .transacting(trx)
        .where('cons_id', localIntervieweeId)
        .first()

      let person           = fieldValues['person']
      let email            = await getPrimaryEmail(person, trx)
      let processorsLength = survey.processors.length

      if (completed && processorsLength > 0) {
        for (let index = 0; index < processorsLength; index++) {
          let processor = survey.processors[index]

          switch (processor) {
            case 'bsd-event-rsvper':
              if (fieldValues['event_id']) {
                let address = await getPrimaryAddress(person, trx)
                let phone   = await getPrimaryPhone(person, trx)
                let zip     = address.zip
                await BSDClient.noFailApiRequest('addRSVPToEvent',
                  {email: email, zip: zip, phone: phone, event_id_obfuscated: fieldValues['event_id']})
              }
              break

            case 'bsd-form-submitter':
              let bsdFormValues = {}

              if (email) {
                fieldValues['Email'] = email
                let fields           = Object.keys(fieldValues)

                for (let index = 0; index < fields.length; index++) {
                  let field   = fields[index]
                  let fieldId = field

                  // Field is not a numeric id
                  if (!(/^\d+$/.test(field))) {
                    let fieldObj = await knex('bsd_survey_fields')
                      .select('signup_form_field_id')
                      .where('signup_form_id', survey.signup_form_id)
                      .where('label', field)
                      .transacting(trx)
                      .first()

                    if (!fieldObj)
                      fieldObj = await knex('bsd_survey_fields')
                        .where('signup_form_id', survey.signup_form_id)
                        .where('label', 'ilike', `[${field}]%`)
                        .transacting(trx)
                        .first()

                    if (fieldObj) {
                      fieldId = fieldObj.signup_form_field_id
                    } else {
                      fieldId = null
                    }
                  }

                  if (fieldId)
                    bsdFormValues[fieldId] = fieldValues[field]
                }

                await BSDClient.noFailApiRequest('processSignup', survey.signup_form_id, bsdFormValues)
              } else {
                log.error(`Could not find an e-mail address for constituent: ${localIntervieweeId}`)
              }
              break
          }
        }
      }

      let promises = [
        knex('bsd_assigned_calls')
          .transacting(trx)
          .where('id', assignedCall.id)
          .del(),
        knex.insertAndFetch('bsd_calls', {
          completed: completed,
          attempted_at: new Date(),
          left_voicemail: leftVoicemail,
          sent_text: sentText,
          reason_not_completed: reasonNotCompleted,
          caller_id: caller.id,
          interviewee_id: assignedCall.interviewee_id,
          call_assignment_id: assignedCall.call_assignment_id
        }, {transaction: trx})
      ]
      await Promise.all(promises)
      return caller
    })
  }
})

const GraphQLCreateAdminEventEmail = mutationWithClientMutationId({
  name: 'CreateAdminEventEmail',
  inputFields: {
    hostEmail: {type: new GraphQLNonNull(GraphQLString)},
    senderEmail: {type: new GraphQLNonNull(GraphQLString)},
    adminEmail: {type: new GraphQLNonNull(GraphQLString)},
    hostEmailSubject: {type: new GraphQLNonNull(GraphQLString)},
    hostMessage: {type: new GraphQLNonNull(GraphQLString)},
    senderMessage: {type: new GraphQLNonNull(GraphQLString)},
    recipients: {type: new GraphQLList(GraphQLString)},
    toolPassword: {type: new GraphQLNonNull(GraphQLString)},
    eventId: {type: new GraphQLNonNull(GraphQLString)}
  },
  outputFields: {
    listContainer: {
      type: GraphQLListContainer,
      resolve: () => SharedListContainer
    }
  },
  mutateAndGetPayload: async({hostEmail, senderEmail, adminEmail, hostEmailSubject, hostMessage, senderMessage, recipients, toolPassword, eventId}, {rootValue}) => {

    adminRequired(rootValue)

    // TODO: remove this goofy protection when the tool is ready
    // for all admins to use it.
    if (toolPassword !== 'solidarity') {
      throw new GraphQLError({
        status: 401,
        message: 'Incorrect password for this tool.'
      })
    }

    await Mailgun.sendAdminEventInvite({
      hostAddress: hostEmail,
      senderAddress: senderEmail,
      hostMessage: hostMessage,
      senderMessage: senderMessage,
      recipientAddress: adminEmail,
      hostEmailSubject: hostEmailSubject
    })

    let existingLookup = await knex.table('fast_fwd_request')
      .select('email_sent_dt')
      .where('event_id', parseInt(fromGlobalId(eventId).id, 10));

    if (existingLookup.length > 0 && existingLookup[0]['email_sent_dt']) {

      throw new GraphQLError({
        status: 403,
        message: 'Fast Forward has already been sent for this event.'
      })

    }

    knex.transaction(async(trx) => {
      for (let i = 0; i < recipients.length; i++) {
        let recipientId    = fromGlobalId(recipients[i]).id
        let recipient      = await rootValue.loaders.bsdPeople.load(recipientId)
        let recipientEmail = await getPrimaryEmail(recipient)

        await Mailgun.sendAdminEventInvite({
          hostAddress: hostEmail,
          senderAddress: senderEmail,
          hostMessage: hostMessage,
          senderMessage: senderMessage,
          recipientAddress: recipientEmail,
          hostEmailSubject: hostEmailSubject
        })

        await knex.insertAndFetch(
          'communications',
          {
            person_id: recipientId,
            type: 'EMAIL'
          },
          {transaction: trx}
        )
      }
    })

    // somewhat hackish; catches Test Mode.
    // don't mark it as sent until it goes out to volunteers.
    if (recipients.length > 0) {
      await knex.table('fast_fwd_request')
        .where('event_id', fromGlobalId(eventId).id)
        .update({
          'email_sent_dt': moment().format('YYYY-MM-DD HH:mm:ss')
        })
    }

    log.info(`FastForward request for event ${eventId} fulfilled by ${rootValue.user.email}`)

    return []
  }
})

const GraphQLCreateFastFwdRequest = mutationWithClientMutationId({
  name: 'CreateFastFwdRequest',
  inputFields: {
    eventId: globalIdField('Event', (obj) => obj.event_id),
    hostMessage: {type: new GraphQLNonNull(GraphQLString)},
  },
  outputFields: () => ({
    fastFwdRequest: {
      type: GraphQLFastFwdRequest
    }
  }),
  mutateAndGetPayload: async({hostMessage, eventId}, {rootValue}) => {

    let intEventId = fromGlobalId(eventId).id

    let existingRecord = await knex.table('fast_fwd_request')
      .where('event_id', intEventId)

    if (existingRecord.length) {
      await knex.table('fast_fwd_request')
        .where('event_id', intEventId)
        .update({
          'host_message': hostMessage
        });

      let updatedRecord = await knex.table('fast_fwd_request')
        .where('event_id', intEventId)

      return updatedRecord;
    }

    return await knex.insertAndFetch('fast_fwd_request', {
      host_message: hostMessage,
      event_id: intEventId
    })

  }
})

const GraphQLFastFwdRequest = new GraphQLObjectType({
  name: 'FastFwdRequest',
  description: 'A request from event hosts to send a FastForward invite',
  fields: () => ({
    id: globalIdField('FastFwdRequest'),
    hostMessage: {type: GraphQLString}
  })
})

const GraphQLCreateCallAssignment = mutationWithClientMutationId({
  name: 'CreateCallAssignment',
  inputFields: {
    name: {type: new GraphQLNonNull(GraphQLString)},
    intervieweeGroup: {type: new GraphQLNonNull(GraphQLString)},
    surveyId: {type: new GraphQLNonNull(GraphQLInt)},
    renderer: {type: new GraphQLNonNull(GraphQLString)},
    processors: {type: new GraphQLList(GraphQLString)},
    instructions: {type: GraphQLString},
    startDate: {type: GraphQLDate},
    endDate: {type: GraphQLDate},
    callerGroupId: {type: GraphQLString}
  },
  outputFields: {
    listContainer: {
      type: GraphQLListContainer,
      resolve: () => SharedListContainer
    }
  },
  mutateAndGetPayload: async({name, intervieweeGroup, surveyId, renderer, processors, instructions, startDate, endDate, callerGroupId}, {rootValue}) => {

    adminRequired(rootValue)
    let groupText = intervieweeGroup
    let group     = null
    let survey    = null
    return knex.transaction(async(trx) => {
      let underlyingSurvey = await knex('bsd_surveys')
        .transacting(trx)
        .where('signup_form_id', surveyId)
        .first()

      if (!underlyingSurvey) {
        try {
          let BSDSurveyResponse       = await BSDClient.getForm(surveyId)
          let model                   = modelFromBSDResponse(BSDSurveyResponse, 'bsd_surveys')
          let BSDSurveyFieldsResponse = await BSDClient.listFormFields(surveyId)
          underlyingSurvey            = await knex.insertAndFetch('bsd_surveys', model, {
            transaction: trx,
            idField: 'signup_form_id'
          })
          let fieldInsertionPromises  = BSDSurveyFieldsResponse.map(async(field) => {
            let model   = modelFromBSDResponse(field, 'bsd_survey_fields')
            let dbField = await knex('bsd_survey_fields').where('signup_form_field_id', model.signup_form_field_id).first()
            return dbField || knex('bsd_survey_fields').insert(model)
          })

          await Promise.all(fieldInsertionPromises);
        } catch (err) {
          if (err && err.response && err.response.statusCode === 409)
            throw new GraphQLError({
              status: 400,
              message: 'Provided survey ID does not exist in BSD.'
            })
          else
            throw err
        }
      }

      survey = await knex.insertAndFetch('gc_bsd_surveys', {
        signup_form_id: surveyId,
        processors: processors
      }, {transaction: trx})

      if (/^\d+$/.test(groupText)) {
        let underlyingGroup = await knex('bsd_groups')
          .transacting(trx)
          .where('cons_group_id', groupText)
          .first()

        if (!underlyingGroup) {
          try {
            let BSDGroupResponse = await BSDClient.getConstituentGroup(groupText)
            let model            = modelFromBSDResponse(BSDGroupResponse, 'bsd_groups')
            underlyingGroup      = await knex.insertAndFetch('bsd_groups', model, {
              transaction: trx,
              idField: 'cons_group_id'
            })
          } catch (err) {
            if (err && err.response && err.response.statusCode === 409)
              throw new GraphQLError({
                status: 400,
                message: 'Provided group ID does not exist in BSD.'
              })
            else
              throw err
          }
        }

        let consGroupID = groupText
        group           = await knex('gc_bsd_groups')
          .transacting(trx)
          .where('cons_group_id', consGroupID)
          .first()

        if (!group)
          group = await knex.insertAndFetch('gc_bsd_groups', {
            'cons_group_id': consGroupID,
          }, {transaction: trx})
      }
      else {
        let query = groupText
        query     = query.toLowerCase().trim().replace(/;*$/, '')

        if (query.indexOf('drop') !== -1 ||
            query.indexOf('truncate') !== -1 ||
            query.indexOf('delete') !== -1 ||
            query.indexOf('update') !== -1) {
          throw new GraphQLError({
            status: 400,
            message: 'Cannot use DROP in your SQL'
          })
        }

        if (query !== EVERYONE_GROUP) {
          let limitedQuery = query
          if (query.indexOf('order by') === -1)
            limitedQuery = limitedQuery + ' order by cons_id'
          limitedQuery = `${limitedQuery} limit 1 offset 0`
          try {
            await knex.raw(limitedQuery)
          } catch (ex) {
            let error = `Invalid SQL query: ${ex.message}`
            throw new GraphQLError({
              status: 400,
              message: error
            })
          }
        }

        group = await knex('gc_bsd_groups')
          .transacting(trx)
          .where('query', query)
          .first()

        if (!group)
          group = await knex.insertAndFetch('gc_bsd_groups', {
            query: query
          }, {transaction: trx})
      }

      startDate     = startDate || new Date()
      callerGroupId = callerGroupId ? fromGlobalId(callerGroupId).id : null

      return knex.insertAndFetch('bsd_call_assignments', {
        name: name,
        renderer: renderer,
        instructions: instructions,
        interviewee_group: group.id,
        gc_bsd_survey_id: survey.id,
        start_dt: startDate,
        end_dt: endDate,
        caller_group: callerGroupId
      }, {transaction: trx});
    })
  }
})

const GraphQLChangeUserPassword = mutationWithClientMutationId({
    name: 'ChangeUserPassword',
    inputFields: {
      currentPassword: {
        type: GraphQLString
      },
      newPassword: {
        type: GraphQLString
      }
    },
    outputFields: {
      dummy: {
        type: GraphQLString
      }
    },
    mutateAndGetPayload: async({currentPassword, newPassword}, {rootValue}) => {
      authRequired(rootValue)

      const user = rootValue.user

      const bsdCredentialsResponse = await BSDClient.checkCredentials(user.email, currentPassword)
      const bsdCredentialsValid    = (typeof bsdCredentialsResponse === 'object' && bsdCredentialsResponse.api.cons)

      if (!bsdCredentialsValid) {
        throw new GraphQLError({
          status: 403,
          message: 'The current password you entered does not match our records. Please try again.'
        })
      }

      try {
        await BSDClient.setConstituentPassword(user.email, newPassword)
      }
      catch (ex) {
        throw new GraphQLError({
          status: 500,
          message: `Something went wrong while changing your password: ${ex.message}`
        })
      }

      return {dummy: ''} //Dummy to satisfy Relay's requirement for some output
    }
  }
)

let RootMutation = new GraphQLObjectType({
  name: 'RootMutation',
  fields: () => ({
    editEvents: GraphQLEditEvents,
    reviewEvents: GraphQLReviewEvents,
    saveEventFile: GraphQLSaveEventFile,
    submitCallSurvey: GraphQLSubmitCallSurvey,
    createCallAssignment: GraphQLCreateCallAssignment,
    deleteEvents: GraphQLDeleteEvents,
    emailHostAttendees: GraphQLEmailHostAttendees,
    createAdminEventEmail: GraphQLCreateAdminEventEmail,
    createFastFwdRequest: GraphQLCreateFastFwdRequest,
    changeUserPassword: GraphQLChangeUserPassword,
  })
})

let RootQuery = new GraphQLObjectType({
  name: 'RootQuery',
  fields: () => ({
    // This wrapper is necessary because relay does not support handling connection types in the root query currently.
    // See https://github.com/facebook/relay/issues/112
    listContainer: {
      type: GraphQLListContainer,
      resolve: (parent, _, {rootValue}) => {
        adminRequired(rootValue)
        return SharedListContainer
      }
    },
    currentUser: {
      type: GraphQLUser,
      resolve: async(parent, _, {rootValue}) => {
        authRequired(rootValue)
        return rootValue.user
      }
    },
    callAssignment: {
      type: GraphQLCallAssignment,
      args: {
        id: {type: new GraphQLNonNull(GraphQLString)}
      },
      resolve: async(root, {id}, {rootValue}) => {
        authRequired(rootValue)
        let localId = fromGlobalId(id)
        if (localId.type !== 'CallAssignment')
          localId = id
        else
          localId = localId.id
        return rootValue.loaders.bsdCallAssignments.load(localId)
      }
    },
    event: {
      type: GraphQLEvent,
      args: {
        id: {type: new GraphQLNonNull(GraphQLString)}
      },
      resolve: async(root, {id}, {rootValue}) => {
        let localId = fromGlobalId(id)
        if (localId.type !== 'Event')
          localId = id
        else
          localId = localId.id
        return rootValue.loaders.bsdEvents.load(localId)
      }
    },
    fastFwdRequest: {
      type: GraphQLFastFwdRequest,
      args: {
        id: {type: new GraphQLNonNull(GraphQLString)}
      },
      resolve: async(root, {id}, {rootValue}) => {
        authRequired(rootValue)
        let localId = fromGlobalId(id)
        if (localId.type === 'FastFwdRequest')
          return knex('fast_fwd_request').where('id', localId)
        else {
          if (localId.type !== 'Event')
            localId = id
          else
            localId = localId.id
          let event = await rootValue.loaders.bsdEvents.load(localId)
          return knex('fast_fwd_request')
            .where('event_id', event.event_id)
        }
      }
    },
    node: nodeField
  })
})

export let Schema = new GraphQLSchema({
  query: RootQuery,
  mutation: RootMutation
})
