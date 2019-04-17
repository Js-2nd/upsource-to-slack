'use strict';
require('log-timestamp');
console.log('starting server');
const _ = require('lodash');
const bodyParser = require('body-parser');
const ect = require('ect');
const express = require('express');
const path = require('path');
const request = require('request');

const config = require('./config.json');
_.defaults(config, {port: 3000});
config.presets = _.chain(config.presets)
	.mapKeys((preset, name) => _.toLower(name))
	.pickBy((preset, name) => isValid(preset) || console.error('invalid preset: ' + name))
	.value();

const page = ect({root: __dirname}).render('template.ect', {
	presets: _.entries(config.presets)
});

const app = express();
app.use(bodyParser.json());
app.get('*', (req, res) => res.send(page));
_.each(config.presets, (preset, name) => {
	app.post('*/' + name, (req, res) => {
		console.log('use preset: ' + name);
		const skip = _.isEmpty(req.query);
		_.defaults(req.query, preset);
		handle(req, res, skip);
	});
});
app.post('*', (req, res) => handle(req, res));
app.listen(config.port);
console.log('listening on port ' + config.port);

function isValid(query) {
	const slack = _.get(query, 'slack');
	if (!_.isString(slack)) return false;
	if (!slack.startsWith('https://hooks.slack.com/services/')) return false;
	return true;
}

function handle(req, res, skipValidate) {
	const {body, query} = req;
	if (!skipValidate && !isValid(query)) {
		console.error('bad query:');
		console.error(query);
		res.sendStatus(400);
		return;
	}
	const dataType = _.get(body, 'dataType');
	const payload = _.invoke(generatePayload, dataType, body, query);
	if (_.isEmpty(payload)) {
		console.warn('unknown data type: ' + dataType);
		res.sendStatus(501);
		return;
	}
	console.log(dataType);
	if (!_.isEmpty(query.channel))
		payload.channel = query.channel;
	request.post({url: query.slack, json: payload}, (err, slackRes, slackBody) => {
		if (err) {
			console.error(err);
			res.sendStatus(500);
			return;
		}
		console.log(`${slackRes.statusCode} ${slackBody}`);
		res.status(slackRes.statusCode).send(slackBody);
	});
}

const generatePayload = {
	DiscussionFeedEventBean: (body, query) => {
		const data = _.assign(feedEventBean(body, query), {
			commentId: _.get(body, 'data.commentId'),
			commentText: _.get(body, 'data.commentText')
		});
		return {
			attachments: [{
				fallback: `${data.tag} New comment by ${data.userName}`,
				pretext: [
					data.tagWithLink,
					data.wrapUrl('New comment', `/review/${data.reviewId}?commentId=${data.commentId}`),
					`by ${data.userName}`
				].join(' '),
				color: query.color,
				text: data.commentText,
				mrkdwn_in: ['text']
			}]
		};
	},
	ReviewCreatedFeedEventBean: (body, query) => {
		const data = _.assign(feedEventBean(body, query), {
			branch: _.get(body, 'data.branch')
		});
		return {
			text: [
				data.tagWithLink,
				`Review created by ${data.userName} on branch`,
				data.wrapUrl(data.branch, `/branch/${data.branch}`)
			].join(' '),
		};
	}
};

function feedEventBean(body, query) {
	const data = {
		projectId: _.get(body, 'projectId'),
		reviewId: _.get(body, 'data.base.reviewId'),
		userName: _.get(body, 'data.base.actor.userName'),
		userEmail: _.get(body, 'data.base.actor.userEmail')
	};
	if (_.isEmpty(query.upsource)) {
		data.wrapUrl = (text) => text;
	} else {
		data.baseUrl = path.join(query.upsource, data.projectId);
		data.wrapUrl = (text, path) => `<${data.baseUrl}${path}|${text}>`;
	}
	data.tag = `[${data.projectId}/${data.reviewId}]`;
	data.tagWithLink = data.wrapUrl(data.tag, `/review/${data.reviewId}`);
	return data;
}
