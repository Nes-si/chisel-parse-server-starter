const {config, hifiAudioConfig, SITE, ROLE_ADMIN, ROLE_EDITOR, promisifyW, getAllObjects} = require('./common');

const {getPayPlan} = require('./payment');

const { SignJWT } = require('jose/dist/node/cjs/jwt/sign'); // Used to create a JWT associated with your Space.
const crypto = require('crypto');
const axios = require('axios');
const { MediaStream, nonstandard: { RTCAudioSource } } = require('wrtc'); // Used to create the `MediaStream` containing your DJ Bot's audio.
const fs = require('fs'); // Used to read the specified audio file from your local disk.
const path = require('path'); // Used to verify that the specified audio file is an MP3 or WAV file.
const decode = require('audio-decode'); // Used to decode the audio file present on your local disk.
const format = require('audio-format'); // Allows us to retrieve available format properties from an audio-like object, such as our `AudioBuffer`.
const convert = require('pcm-convert'); // Allows us to convert our `AudioBuffer` into the proper `int16` format.
import { Point3D, HiFiAudioAPIData, HiFiCommunicator, preciseInterval } from 'hifi-spatial-audio'; // Used to interface with the Spatial Audio API.
require('./users_code');

// Get Site nameId to generate Model names
const getSiteNameId = async(siteId) => {
  const siteQuery = new Parse.Query('Site');
  siteQuery.equalTo('objectId', siteId);
  const siteRecord = await siteQuery.first({useMasterKey: true});
  if (!siteRecord || !siteRecord.get('nameId')) return null;
  return siteRecord.get('nameId');
}

Parse.Cloud.define("myTalks", async (request) => {
  const { participant, siteId } = request.params;
  try {
    if (!participant)
      return { status: 'error', message: 'Insufficient Data!' };
    
    const myTalks = await getMyTalks(participant, siteId);
    
    return { status: 'success', myTalks };
  } catch (error) {
    console.log('inside getMyTalks', error);
    return { status: 'error', error };
  }
});

const getMyTalks = async (participant, siteId) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(siteId);
    if (siteNameId === null) return { status: 'error', message: 'Invalid siteId' };
    const PARTICIPANT_MODEL = `ct____${siteNameId}____Participant`;
    const TALK_MODEL = `ct____${siteNameId}____Talk`;
    const TALK_WRAP_MODEL = `ct____${siteNameId}____TalkWrap`;
    
    const Participant = Parse.Object.extend(PARTICIPANT_MODEL);
    const Talk = Parse.Object.extend(TALK_MODEL);
    const user = new Participant();
    user.id = participant;

    const talkWrapQuery = new Parse.Query(TALK_WRAP_MODEL);
    talkWrapQuery.equalTo('t__status', 'Published');
    talkWrapQuery.equalTo('Participants', user);
    const filteredTalkWraps = await talkWrapQuery.find();

    const talks = [];
    const talkIds = [];
    for (const talkWrap of filteredTalkWraps) {
      const talk = new Talk();
      talk.id = talkWrap.get('Talk')[0].id;
      talkIds.push(talk.id);
      talks.push(talk);
    }

    const talksQuery = new Parse.Query(TALK_MODEL);
    talksQuery.equalTo('t__status', 'Published');
    talksQuery.containedIn('objectId', talkIds);
    const myParseTalks = await talksQuery.find();
        
    let myTalks = [];
    if (myParseTalks) {
      myTalks = myParseTalks.map((parseTalk) => ({
        id: parseTalk.id,
        start: parseTalk.get('start'),
        end: parseTalk.get('end'),
        title: parseTalk.get('title'),
        slug: parseTalk.get('slug')
      }));
    }
    return myTalks;
  } catch (error) {
    console.log('inside  myTalks function', error)
    throw error;
  }
}


Parse.Cloud.define("joinTalk", async(request) => {
  const { slug, participantId, siteId } = request.params;
  try {
    if (!participantId || !slug)
      return { status: 'error', message: 'Insufficient Data!' };

      
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(siteId);
    if (siteNameId === null) return { status: 'error', message: 'Invalid siteId' };

    const PARTICIPANT_MODEL = `ct____${siteNameId}____Participant`;
    const TALK_MODEL = `ct____${siteNameId}____Talk`;
    const TALK_WRAP_MODEL = `ct____${siteNameId}____TalkWrap`;
    
   
    const Participant = Parse.Object.extend(PARTICIPANT_MODEL);
    const user = new Participant();
    user.id = participantId;

    // Server Data Update
    const talkQuery = new Parse.Query(TALK_MODEL);
    talkQuery.equalTo('slug', slug);
    talkQuery.equalTo('t__status', 'Published');
    const talkParseObject = await talkQuery.first();
    if (!talkParseObject) {
      throw ('No Talk record found. Please contact administrator.');
    }

    const title = talkParseObject.get('title');
    const start = talkParseObject.get('start');
    const end = talkParseObject.get('end');
    const max_capacity = talkParseObject.get('max_capacity');
    const self_assign = talkParseObject.get('self_assign');
    if(!self_assign) {
      throw('Not joinable: Talk is not self-assignable.');
    }

    const myTalks = await getMyTalks(participantId, siteId);
    const duplicateSlotTalk = isTimeslotAvailable(myTalks, start);
    
    if (duplicateSlotTalk !== null) {
      throw(`You are unable to join this session as you are already booked for ${duplicateSlotTalk.title} at ${duplicateSlotTalk.start}.`);
    }
    
    let isJoinable = abracademyConditionCheck(myTalks, slug);
    if (!isJoinable) {
      throw('Not joinable: Abracademy unavailable.');
    }

    const talkWrapQuery = new Parse.Query(TALK_WRAP_MODEL);
    talkWrapQuery.equalTo('Talk', talkParseObject);
    talkWrapQuery.equalTo('t__status', 'Published');
    let talkWrapParseObject = await talkWrapQuery.first();
    if (!talkWrapParseObject) {
      const TalkWrap = Parse.Object.extend(TALK_WRAP_MODEL); 
      const talkWrapName=`${title}-${new Date(start).toISOString()}-${new Date(end).toISOString()}`;
      talkWrapParseObject = new TalkWrap();
      talkWrapParseObject.set('Name', talkWrapName);
      talkWrapParseObject.set('Talk', [talkParseObject]);
      talkWrapParseObject.set('Participants', [user]);
      talkWrapParseObject.set('t__status', 'Published');
    } else {
      const participantIds = talkWrapParseObject.get('Participants');
      const alreadyBooked = participantIds.reduce((acc, cur) => (acc || cur.id === participantId), false);
      if (alreadyBooked) {
        throw('Not joinable: Already Booked');
      }
      isJoinable = isNaN(max_capacity) || max_capacity ===0 || max_capacity > participantIds.length;
      if (!isJoinable) {
        throw('Not joinable: Out of capacity');
      }
      talkWrapParseObject.set('Participants', [...(talkWrapParseObject.get('Participants') || []), user])
    }
    await talkWrapParseObject.save();

    const newMyTalks = await getMyTalks(participantId, siteId);
    return { status: 'success', myTalks: newMyTalks };
  } catch(error) {
    console.log('inside joinTalk', error);
    return { status: 'error', error };
  }
});



Parse.Cloud.define("dropTalk", async(request) => {
  const { slug, participantId, siteId } = request.params;
  try {
    if (!participantId || !slug)
      return { status: 'error', message: 'Insufficient Data!' };

      
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(siteId);
    if (siteNameId === null) return { status: 'error', message: 'Invalid siteId' };

    const PARTICIPANT_MODEL = `ct____${siteNameId}____Participant`;
    const TALK_MODEL = `ct____${siteNameId}____Talk`;
    const TALK_WRAP_MODEL = `ct____${siteNameId}____TalkWrap`;
    
   
    const Participant = Parse.Object.extend(PARTICIPANT_MODEL);
    const user = new Participant();
    user.id = participantId;

    // Server Data Update
    const talkQuery = new Parse.Query(TALK_MODEL);
    talkQuery.equalTo('slug', slug);
    talkQuery.equalTo('t__status', 'Published');
    const talkParseObject = await talkQuery.first();
    if (!talkParseObject) {
      throw ('No Talk record found. Please contact administrator.');
    }

    const self_assign = talkQuery.get('self_assign');
    if (!self_assign) 
      throw('Talk is not self assignable, you can\'t drop from the talk');

    const talkWrapQuery = new Parse.Query(TALK_WRAP_MODEL);
    talkWrapQuery.equalTo('Talk', talkParseObject);
    talkWrapQuery.equalTo('Participants', user);
    talkWrapQuery.equalTo('t__status', 'Published');
    let talkWrapParseObject = await talkWrapQuery.first();
    if (!talkWrapParseObject || !talkWrapParseObject.get('Participants')) {
      throw('No participant record found')
    }
    
    // Drop by participantId
    const participants = talkWrapParseObject.get('Participants');
    const filteredParticipants = participants.filter(participant => participant.id !== participantId);
    talkWrapParseObject.set('Participants', filteredParticipants);
    await talkWrapParseObject.save();

    const newMyTalks = await getMyTalks(participantId, siteId);
    return { status: 'success', myTalks: newMyTalks };
  } catch(error) {
    console.log("inside dropTalk", error);
    return { status: 'error', error };
  }
});


/* isJoinable check utility functions */
const isTimeslotAvailable = (myTalks, start) => {
  for (const talk of myTalks) {
    if (Date.parse(talk.start) === Date.parse(start)) return talk;
    if (talk.start === start) return talk;
  }
  return null;
}

const abracademyConditionCheck = (myTalks, slug) => {
  if (slug.includes('abracademy-workshop') === false) return true;
  for (const talk of myTalks) {
    if (talk.slug.includes('abracademy-workshop')) return false;
  }
  return true;
}



const checkRights = (user, obj) => {
  const acl = obj.getACL();
  if (!acl)
    return true;

  const read = acl.getReadAccess(user.id);
  const write = acl.getWriteAccess(user.id);

  const pRead = acl.getPublicReadAccess();
  const pWrite = acl.getPublicWriteAccess();

  return read && write || pRead && pWrite;
};


const getTableData = async (table) => {
  const endpoint = '/schemas/' + table;

  try {
    const response = await Parse.Cloud.httpRequest({
      url: config.serverURL + endpoint,
      method: 'GET',
      mode: 'cors',
      cache: 'no-cache',
      headers: {
        'Content-Type': 'application/json',
        'X-Parse-Application-Id': config.appId,
        'X-Parse-Master-Key': config.masterKey
      }
    });

    if (response.status == 200)
      return response.data;

  } catch (e) {}

  return null;
};

const setTableData = async (table, data, method = 'POST') => {
  const endpoint = '/schemas/' + table;

  const response = await Parse.Cloud.httpRequest({
    url: config.serverURL + endpoint,
    method,
    mode: 'cors',
    cache: 'no-cache',
    headers: {
      'Content-Type': 'application/json',
      'X-Parse-Application-Id': config.appId,
      'X-Parse-Master-Key': config.masterKey
    },
    body: JSON.stringify(data)
  });

  if (response.status != 200)
    throw response.status;
};

const deleteTable = async (table) => {
  const endpoint = '/schemas/' + table;

  const response = await Parse.Cloud.httpRequest({
    url: config.serverURL + endpoint,
    method: 'DELETE',
    mode: 'cors',
    cache: 'no-cache',
    headers: {
      'Content-Type': 'application/json',
      'X-Parse-Application-Id': config.appId,
      'X-Parse-Master-Key': config.masterKey
    }
  });

  if (response.status != 200)
    throw response.status;
};


const deleteContentItem = async (user, tableName, itemId) => {
  const item = await new Parse.Query(tableName)
    .get(itemId, {useMasterKey: true});

  if (!checkRights(user, item))
    throw "Access denied!";


  //removing MediaItem's belonging to content item
  const tableData = await getTableData(tableName);

  for (let field in tableData.fields) {
    const val = tableData.fields[field];
    if (val.type == 'Pointer' && val.targetClass == 'MediaItem') {
      const media = item.get(field);
      //!! uncontrolled async operation
      if (media)
        media.destroy({useMasterKey: true});
    }
  }


  //seeking draft version of content item
  const itemDraft = await new Parse.Query(tableName)
    .equalTo('t__owner', item)
    .first({useMasterKey: true});

  if (itemDraft) {
    if (!checkRights(user, itemDraft))
      throw "Access denied!";

    for (let field in tableData.fields) {
      const val = tableData.fields[field];
      if (val.type == 'Pointer' && val.targetClass == 'MediaItem') {
        const media = itemDraft.get(field);
        //!! uncontrolled async operation
        if (media)
          media.destroy({useMasterKey: true});
      }
    }

    await itemDraft.destroy({useMasterKey: true});
  }

  await item.destroy({useMasterKey: true});
};

const deleteModel = async (user, model, deleteRef = true, deleteModel = true) => {
  if (!checkRights(user, model))
    throw "Access denied!";


  //removing model fields
  let fields = await getAllObjects(
    new Parse.Query('ModelField')
      .equalTo('model', model)
  );

  let promises = [];
  for (let field of fields) {
    if (checkRights(user, field))
      promises.push(promisifyW(field.destroy({useMasterKey: true})));
  }
  await Promise.all(promises);


  //removing content items of model
  const tableName = model.get('tableName');
  const items = await getAllObjects(new Parse.Query(tableName));
  promises = [];
  for (let item of items) {
    promises.push(promisifyW(deleteContentItem(user, tableName, item.id)));
  }
  await Promise.all(promises);

  try {
    await deleteTable(tableName);
  } catch (e) {}


  //removing reference validation to model
  if (deleteRef) {
    const models = await getAllObjects(
      new Parse.Query('Model')
        .equalTo('site', model.get('site'))
    );
    fields = await getAllObjects(
      new Parse.Query('ModelField')
        .containedIn('model', models)
        .notEqualTo('model', model)
        .equalTo('type', 'Reference')
    );

    const promises = [];
    for (let field of fields) {
      const validations = field.get('validations');
      if (!validations || !validations.models || !validations.models.active || !validations.models.modelsList)
        continue;

      const i = validations.models.modelsList.indexOf(model.get('nameId'));
      if (i == -1)
        continue;

      validations.models.modelsList.splice(i, 1);
      field.set('validations', validations);
      promises.push(promisifyW(field.save(null, {useMasterKey: true})));
    }
    await Promise.all(promises);
  }


  //remove model
  if (deleteModel)
    await model.destroy({useMasterKey: true});
};


Parse.Cloud.define("deleteContentItem", async (request) => {
  if (!request.user)
    throw 'Must be signed in to call this Cloud Function.';

  const {tableName, itemId} = request.params;
  if (!tableName || !itemId)
    throw 'There is no tableName or itemId params!';

  try {
    await deleteContentItem(request.user, tableName, itemId);
    return "Successfully deleted content item.";
  } catch (error) {
    throw `Could not delete content item: ${error}`;
  }
});

Parse.Cloud.beforeDelete(`Model`, async request => {
  if (request.master)
    return;

  try {
    return await deleteModel(request.user, request.object, true, false);
  } catch (error) {
    throw `Could not delete model: ${JSON.stringify(error, null, 2)}`;
  }
});

Parse.Cloud.beforeDelete(`Site`, async request => {
  if (request.master)
    return;

  const site = request.object;

  if (!checkRights(request.user, site))
    throw "Access denied!";

  //removing site's models
  const models = await getAllObjects(
    new Parse.Query('Model')
      .equalTo('site', site));

  let promises = [];
  for (let model of models)
    promises.push(promisifyW(
      deleteModel(request.user, model, false)
    ));
  await Promise.all(promises);


  //removing site's collaborations
  const collabs = await getAllObjects(
    new Parse.Query('Collaboration')
      .equalTo('site', site));

  promises = [];
  for (let collab of collabs)
    promises.push(promisifyW(
      collab.destroy({useMasterKey: true})
    ));
  await Promise.all(promises);
});


const onCollaborationModify = async (collab, deleting = false) => {
  const site = collab.get('site');
  const user = collab.get('user');
  const role = collab.get('role');

  if (!user)
    return;

  await site.fetch({useMasterKey: true});

  //ACL for collaborations
  const owner = site.get('owner');
  let collabACL = collab.getACL();
  if (!collabACL)
    collabACL = new Parse.ACL(owner);

  //getting all site collabs
  const collabs = await getAllObjects(
    new Parse.Query('Collaboration')
      .equalTo('site', site)
      .notEqualTo('user', user));

  for (let tempCollab of collabs) {
    if (tempCollab.id == collab.id)
      continue;

    //set ACL for others collab
    let tempCollabACL = tempCollab.getACL();
    if (!tempCollabACL)
      tempCollabACL = new Parse.ACL(owner);

    tempCollabACL.setReadAccess(user, !deleting && role == ROLE_ADMIN);
    tempCollabACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);

    tempCollab.setACL(tempCollabACL);
    //!! uncontrolled async operation
    tempCollab.save(null, {useMasterKey: true});

    //set ACL for current collab
    if (!deleting) {
      const tempRole = tempCollab.get('role');
      const tempUser = tempCollab.get('user');

      if (!tempUser)
        continue;

      collabACL.setReadAccess(tempUser, tempRole == ROLE_ADMIN);
      collabACL.setWriteAccess(tempUser, tempRole == ROLE_ADMIN);
    }
  }

  collabACL.setReadAccess(user, true);
  collabACL.setWriteAccess(user, true);
  collab.setACL(collabACL);


  //ACL for site
  let siteACL = site.getACL();
  if (!siteACL)
    siteACL = new Parse.ACL(owner);

  siteACL.setReadAccess(user, !deleting);
  siteACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);
  site.setACL(siteACL);
  //!! uncontrolled async operation
  site.save(null, {useMasterKey: true});


  //ACL for media items
  const mediaItems = await getAllObjects(
    new Parse.Query('MediaItem')
      .equalTo('site', site));

  for (let item of mediaItems) {
    let itemACL = item.getACL();
    if (!itemACL)
      itemACL = new Parse.ACL(owner);

    itemACL.setReadAccess(user, !deleting);
    itemACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);
    item.setACL(itemACL);
    //!! uncontrolled async operation
    item.save(null, {useMasterKey: true});
  }


  //ACL for models and content items
  const models = await getAllObjects(
    new Parse.Query('Model')
      .equalTo('site', site));

  for (let model of models) {
    let modelACL = model.getACL();
    if (!modelACL)
      modelACL = new Parse.ACL(owner);

    modelACL.setReadAccess(user, !deleting);
    modelACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);
    model.setACL(modelACL);
    //!! uncontrolled async operation
    model.save(null, {useMasterKey: true});

    const tableName = model.get('tableName');
    //!! uncontrolled async operation
    getTableData(tableName)
      .then(response => {
        let CLP = response ? response.classLevelPermissions : null;
        if (!CLP)
          CLP = {
            'get': {},
            'find': {},
            'create': {},
            'update': {},
            'delete': {},
            'addField': {}
          };

        if (!deleting) {
          CLP['get'][user.id] = true;
          CLP['find'][user.id] = true;
        } else {
          if (CLP['get'].hasOwnProperty(user.id))
            delete CLP['get'][user.id];
          if (CLP['find'].hasOwnProperty(user.id))
            delete CLP['find'][user.id];
        }

        if (!deleting && (role == ROLE_ADMIN || role == ROLE_EDITOR)) {
          CLP['create'][user.id] = true;
          CLP['update'][user.id] = true;
          CLP['delete'][user.id] = true;
        } else {
          if (CLP['create'].hasOwnProperty(user.id))
            delete CLP['create'][user.id];
          if (CLP['update'].hasOwnProperty(user.id))
            delete CLP['update'][user.id];
          if (CLP['delete'].hasOwnProperty(user.id))
            delete CLP['delete'][user.id];
        }

        if (!deleting && role == ROLE_ADMIN)
          CLP['addField'][user.id] = true;
        else if (CLP['addField'].hasOwnProperty(user.id))
          delete CLP['addField'][user.id];

        //!! uncontrolled async operation
        const data = {"classLevelPermissions": CLP};
        setTableData(tableName, data)
          .catch(() => setTableData(tableName, data, 'PUT'));
      });
  }


  //ACL for fields
  const fields = await getAllObjects(
    new Parse.Query('ModelField')
      .containedIn('model', models));

  for (let field of fields) {
    let fieldACL = field.getACL();
    if (!fieldACL)
      fieldACL = new Parse.ACL(owner);

    fieldACL.setReadAccess(user, !deleting);
    fieldACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);
    field.setACL(fieldACL);
    //!! uncontrolled async operation
    field.save(null, {useMasterKey: true});
  }
};


Parse.Cloud.beforeSave("Collaboration", async request => {
  if (request.master)
    return;

  const collab = request.object;
  if (!checkRights(request.user, collab))
    throw "Access denied!";

  return onCollaborationModify(collab);
});

Parse.Cloud.beforeDelete("Collaboration", async request => {
  if (request.master)
    return;

  const collab = request.object;
  if (!checkRights(request.user, collab))
    throw "Access denied!";

  return onCollaborationModify(collab, true);
});

Parse.Cloud.beforeSave(Parse.User, request => {
  const user = request.object;
  const email = user.get('email');
  if (user.get('username') != email)
    user.set('username', email);
});

Parse.Cloud.afterSave(Parse.User, async request => {
  const user = request.object;

  const collabs = await new Parse.Query('Collaboration')
    .equalTo('email', user.get('email'))
    .find({useMasterKey: true});

  const promises = [];

  for (let collab of collabs) {
    if (collab.get('user'))
      continue;

    collab.set('user', user);
    collab.set('email', '');

    promises.push(collab.save(null, {useMasterKey: true}));
    promises.push(promisifyW(onCollaborationModify(collab)));
  }

  await Promise.all(promises);
});

Parse.Cloud.beforeSave("Site", async request => {
  if (request.master)
    return;

  //updating an existing site
  if (request.object.id)
    return true;

  const user = request.user;
  if (!user)
    throw 'Must be signed in to save sites.';

  const payPlan = await getPayPlan(user);
  if (!payPlan)
    return true;

  const sitesLimit = payPlan.get('limitSites');
  if (!sitesLimit)
    return true;

  const sites = await new Parse.Query('Site')
    .equalTo('owner', user)
    .count({useMasterKey: true});

  if (sites >= sitesLimit)
    throw `The user has exhausted their sites' limit!`;

  return true;
});

Parse.Cloud.beforeSave(`Model`, async request => {
  if (request.master)
    return;

  const model = request.object;
  if (model.id)
    return;

  const site = model.get('site');
  await site.fetch({useMasterKey: true});

  //ACL for collaborations
  const owner = site.get('owner');
  const modelACL = new Parse.ACL(owner);

  const collabs = await getAllObjects(
    new Parse.Query('Collaboration')
      .equalTo('site', site));

  const admins = [owner.id];
  const writers = [owner.id];
  const all = [owner.id];

  for (let collab of collabs) {
    const user = collab.get('user');
    const role = collab.get('role');

    if (!user)
      continue;

    modelACL.setReadAccess(user, true);
    modelACL.setWriteAccess(user, role == ROLE_ADMIN);

    if (role == ROLE_ADMIN)
      admins.push(user.id);
    if (role == ROLE_ADMIN || role == ROLE_EDITOR)
      writers.push(user.id);
    all.push(user.id);
  }

  model.setACL(modelACL);

  //set CLP for content table
  const CLP = {
    'get': {},
    'find': {},
    'create': {},
    'update': {},
    'delete': {},
    'addField': {}
  };

  for (let user of all) {
    CLP['get'][user] = true;
    CLP['find'][user] = true;
  }
  for (let user of writers) {
    CLP['create'][user] = true;
    CLP['update'][user] = true;
    CLP['delete'][user] = true;
  }
  for (let user of admins) {
    CLP['addField'][user] = true;
  }

  const data = {"classLevelPermissions": CLP};
  await setTableData(model.get('tableName'), data);
});

Parse.Cloud.beforeSave(`ModelField`, async request => {
  if (request.master)
    return;

  const field = request.object;
  if (field.id)
    return;

  const model = field.get('model');
  await model.fetch({useMasterKey: true});

  const site = model.get('site');
  await site.fetch({useMasterKey: true});

  //ACL for collaborations
  const owner = site.get('owner');
  const fieldACL = new Parse.ACL(owner);

  const collabs = await getAllObjects(
    new Parse.Query('Collaboration')
      .equalTo('site', site));

  for (let collab of collabs) {
    const user = collab.get('user');
    const role = collab.get('role');

    if (!user)
      continue;

    fieldACL.setReadAccess(user, true);
    fieldACL.setWriteAccess(user, role == ROLE_ADMIN);
  }

  field.setACL(fieldACL);
});

Parse.Cloud.beforeSave(`MediaItem`, async request => {
  if (request.master)
    return;

  const item = request.object;
  if (item.id)
    return;

  const site = item.get('site');
  await site.fetch({useMasterKey: true});

  //ACL for collaborations
  const owner = site.get('owner');
  const itemACL = new Parse.ACL(owner);

  const collabs = await getAllObjects(
    new Parse.Query('Collaboration')
      .equalTo('site', site));

  for (let collab of collabs) {
    const user = collab.get('user');
    const role = collab.get('role');

    if (!user)
      continue;

    itemACL.setReadAccess(user, true);
    itemACL.setWriteAccess(user, role == ROLE_ADMIN);
  }

  item.setACL(itemACL);
});


Parse.Cloud.define("onContentModify", async request => {
  if (!request.user)
    throw 'Must be signed in to call this Cloud Function.';

  const {URL} = request.params;
  if (!URL)
    return 'Warning! There is no content hook!';

  const response = await Parse.Cloud.httpRequest({
    url: URL,
    method: 'GET'
  });

  if (response.status == 200)
    return response.data;
  else
    throw response.status;
});

Parse.Cloud.define("inviteUser", async request => {
  if (!request.user)
    throw 'Must be signed in to call this Cloud Function.';

  const {email, siteName} = request.params;
  if (!email || !siteName)
    throw 'Email or siteName is empty!';

  console.log(`Send invite to ${email} ${new Date()}`);

  const {AppCache} = require('parse-server/lib/cache');
  const emailAdapter = AppCache.get(config.appId)['userController']['adapter'];

  const emailSelf = request.user.get('email');
  const link = `${SITE}/sign?mode=register&email=${email}`;

  try {
    await emailAdapter.send({
      templateName: 'inviteEmail',
      recipient: email,
      variables: {siteName, emailSelf, link}
    });
    console.log(`Invite sent to ${email} ${new Date()}`);
    return "Invite email sent!";

  } catch (error) {
    console.log(`Got an error in inviteUser: ${error}`);
    throw error;
  }
});

Parse.Cloud.define("checkPassword", request => {
  if (!request.user)
    throw 'Must be signed in to call this Cloud Function.';

  const {password} = request.params;
  if (!password)
    throw 'There is no password param!';

  const username = request.user.get('username');

  return Parse.User.logIn(username, password);
});




/* -------------- Hi Fi Spatial Audio related ------------------- */
const generateSpace = async (vulcanSpaceId, name) => {
  try {
    const response = await axios.get(`https://api.highfidelity.com/api/v1/spaces/create?token=${hifiAudioConfig.adminToken}&name=${vulcanSpaceId}_${name}`);
    if (!response.data || !response.data['space-id'])
      return null;
    return response.data['space-id'];
    
  } catch (e) {
    console.error(e);
    throw e;
  }
}

// Hifi Spatial Audio Token
// - Check Parse server for existing space token, return if found 
// - generate one if doesn't exist,
// - store newly generated one into Parse
const findOrGenerateSpace = async (vulcanSpaceId, name) => {
  const SPACE_MAPPING_MODEL = 'SpaceMapping';
  try {
    // Find the existing one first.
    const spaceQuery = new Parse.Query(SPACE_MAPPING_MODEL);
    spaceQuery.equalTo('vulcan_space_id', vulcanSpaceId);
    const spaceRecord = await spaceQuery.first({useMasterKey: true});

    if (!spaceRecord || !spaceRecord.get('space_token')) {
      // When no existing record, generate one.
      const spaceToken = await generateSpace(vulcanSpaceId, name);
      if (spaceToken === null)
        throw 'No space token generated';

      // Store newly generated one into Parse Server
      const SpaceMapping = Parse.Object.extend(SPACE_MAPPING_MODEL); 
      const newSpaceMappingObject = new SpaceMapping();
      newSpaceMappingObject.set('name', name);
      newSpaceMappingObject.set('vulcan_space_id', vulcanSpaceId);
      newSpaceMappingObject.set('space_token', spaceToken);
      await newSpaceMappingObject.save();
      return spaceToken;
    }
    return spaceRecord.get('space_token');
  } catch (e) {
    console.log('error in findOrGenerateSpace', e);
  }
}

// Cloud function : End point for users for JWT token
// - find or generate spce id first
// - generate JWT with above space Id and given user ID
Parse.Cloud.define("generateAudioJWT", async (request) => {
  const { userID, vulcanSpaceId, spaceName } = request.params;
  const hifiJWT = await generateAudioJWT(userID, vulcanSpaceId, spaceName);
  return hifiJWT;
});

const generateAudioJWT = async(userID, vulcanSpaceId, spaceName) => {
  let hiFiJWT;
  try {
    const spaceId = await findOrGenerateSpace(vulcanSpaceId, spaceName);

    // - generate JWT with above space Id and given user ID
    const SECRET_KEY_FOR_SIGNING = crypto.createSecretKey(Buffer.from(hifiAudioConfig.appSecret, "utf8"));
    hiFiJWT = await new SignJWT({
      "user_id": userID,
      "app_id": hifiAudioConfig.appId,
      "space_id": spaceId
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .sign(SECRET_KEY_FOR_SIGNING);

    return hiFiJWT;
  } catch (error) {
    console.error(`Couldn't create JWT! Error:\n${error}`);
    return null;
  }
}


Parse.Cloud.define("startAudioBox", async (request) => {
  const { vulcanSpaceId, spaceName, objectId, audioFileName, hiFiGain, position } = request.params;
  // Generate the JWT used to connect to our High Fidelity Space.
  let hiFiJWT = await generateAudioJWT(objectId, vulcanSpaceId, spaceName);
  if (!hiFiJWT) {
    return;
  }
  await startAudioBox(`./music/${audioFileName}.mp3`, position, hiFiGain, hiFiJWT);
});

Parse.Cloud.define("stopAudioBox", async (request) => {
  const { vulcanSpaceId, spaceName, objectId } = request.params;
  // Generate the JWT used to connect to our High Fidelity Space.
  let hiFiJWT = await generateAudioJWT(objectId, vulcanSpaceId, spaceName);
  if (!hiFiJWT) {
    return;
  }
  await stopAudioBox(hiFiJWT);
});

/**
 * Play the audio from a file into a High Fidelity Space. The audio will loop indefinitely.
 *
 * @param {string} audioPath - Path to an `.mp3` or `.wav` audio file
 * @param {object} position - The {x, y, z} point at which to spatialize the audio.
 * @param {number} hiFiGain - Set above 1 to boost the volume of the bot, or set below 1 to attenuate the volume of the bot.
 */
async function startAudioBox(audioPath, position, hiFiGain, hiFiJWT) {
  // Make sure we've been passed an `audioPath`...
  if (!audioPath) {
    console.error(`Audio file path not specified! Please specify an audio path with "--audio "`);
    return;
  }

  // Make sure the `audioPath` we've been passed is actually a file that exists on the filesystem...
  if (!fs.statSync(audioPath).isFile()) {
    console.error(`Specified path "${audioPath}" is not a file!`);
    return;
  }

  // Make sure that the file at `audioPath` is a `.mp3` or a `.wav` file.
  let audioFileExtension = path.extname(audioPath).toLowerCase();
  if (!(audioFileExtension === ".mp3" || audioFileExtension === ".wav")) {
    console.error(`Specified audio file must be a \`.mp3\` or a \`.wav\`!\
Instead, it's a \`${audioFileExtension}\``);
    return;
  }

  // Read the audio file from our local filesystem into a file buffer.
  const fileBuffer = fs.readFileSync(audioPath),
    // Decode the audio file buffer into an AudioBuffer object.
    audioBuffer = await decode(fileBuffer),
    // Obtain various necessary pieces of information about the audio file.
    { numberOfChannels, sampleRate, length, duration } = audioBuffer,
    // Get the correct format of the `audioBuffer`.
    parsed = format.detect(audioBuffer),
    // Convert the parsed `audioBuffer` into the proper format.
    convertedAudioBuffer = convert(audioBuffer, parsed, 'int16'),
    // Define the number of bits per sample encoded into the original audio file. `16` is a commonly-used number. The DJ Bot may malfunction
    // if the audio file specified is encoded using a different number of bits per sample.
    BITS_PER_SAMPLE = 16,
    // Define the interval at which we want to fill the sample data being streamed into the `MediaStream` sent up to the Server.
    // `wrtc` expects this to be 10ms.
    TICK_INTERVAL_MS = 10,
    // There are 1000 milliseconds per second :)
    MS_PER_SEC = 1000,
    // The number of times we fill up the audio buffer per second.
    TICKS_PER_SECOND = MS_PER_SEC / TICK_INTERVAL_MS,
    // The number of audio samples present in the `MediaStream` audio buffer per tick.
    SAMPLES_PER_TICK = sampleRate / TICKS_PER_SECOND,
    // Contains the audio sample data present in the `MediaStream` audio buffer sent to the Server.
    currentSamples = new Int16Array(numberOfChannels * SAMPLES_PER_TICK),
    // Contains all of the data necessary to pass to our `RTCAudioSource()`, which is sent to the Server.
    currentAudioData = {
      samples: currentSamples,
      sampleRate,
      bitsPerSample: BITS_PER_SAMPLE,
      channelCount: numberOfChannels,
      numberOfFrames: SAMPLES_PER_TICK
    },
    // The `MediaStream` sent to the server consists of an "Audio Source" and, within that Source, a single "Audio Track".
    source = new RTCAudioSource(),
    track = source.createTrack(),
    // This is the final `MediaStream` sent to the server. The data within that `MediaStream` will be updated on an interval.
    inputAudioMediaStream = new MediaStream([track]),
    // Define the initial HiFi Audio API Data used when connecting to the Spatial Audio API.
    initialHiFiAudioAPIData = new HiFiAudioAPIData({
      position: new Point3D(position),
      hiFiGain: hiFiGain
    }),
    // Set up the HiFiCommunicator used to communicate with the Spatial Audio API.
    hifiCommunicator = new HiFiCommunicator({ initialHiFiAudioAPIData });

  // Set the Input Audio Media Stream to the `MediaStream` we created above. We'll fill it up with data below.
  await hifiCommunicator.setInputAudioMediaStream(inputAudioMediaStream);

  // Connect to our High Fidelity Space.
  let connectResponse;
  try {
    connectResponse = await hifiCommunicator.connectToHiFiAudioAPIServer(hiFiJWT);
  } catch (e) {
    console.error(`Call to \`connectToHiFiAudioAPIServer()\` failed! Error:\
${JSON.stringify(e)}`);
    return;
  }

  // `sample` defines where we are in the decoded audio stream from above. `0` means "we're at the beginning of the audio file".
  let sample = 0;
  // Called once every `TICK_INTERVAL_MS` milliseconds.
  let tick = () => {
    // This `for()` loop fills up `currentSamples` with the right amount of raw audio data grabbed from the correct position
    // in the decoded audio file.
    for (let frame = 0; frame < SAMPLES_PER_TICK; frame++, sample++) {
      for (let channel = 0; channel < numberOfChannels; channel++) {
        currentSamples[frame * numberOfChannels + channel] =
          convertedAudioBuffer[sample * numberOfChannels + channel] || 0;
      }
    }

    // This is the function that actually modifies the `MediaStream` we're sending to the Server.
    source.onData(currentAudioData);

    // Check if we're at the end of our audio file. If so, reset the `sample` so that we loop.
    if (sample > length) {
      sample = 0;
    }
  }

  // Set up the `preciseInterval` used to regularly update the `MediaStream` we're sending to the Server.
  preciseInterval(tick, TICK_INTERVAL_MS);

  console.log(`DJ Bot connected. Let's DANCE!`);
  // return hifiCommunicator;
}


async function stopAudioBox(hiFiJWT) {
  const hifiCommunicator = new HiFiCommunicator();

  // Connect to our High Fidelity Space.
  let connectResponse;
  try {
    connectResponse = await hifiCommunicator.connectToHiFiAudioAPIServer(hiFiJWT);
    await hifiCommunicator.disconnectFromHiFiAudioAPIServer();
  } catch (e) {
    console.error(`Call to \`connectToHiFiAudioAPIServer()\` failed! Error:\
${JSON.stringify(e)}`);
    return;
  }

}
