require('dotenv').config();
const nistagram = require('nistagram');
const fs = require('fs');
const knex = require('knex')(require('./knexfile'));
const twit = require('twit');
const axios = require('axios');
const path = require('path');

// const user = JSON.parse(fs.readFileSync('user.json', 'UTF-8'));
const Instagram = new nistagram.default();
const members = ['chelseavanmeijr', 'kezia.lizina', 'annabelle_sjy', 'shella_fernanda', 'starbeofficial'];
const userIds = ['6920747200', '1807555179', '1591211326', '454337981', '11226955255'];

const upsert = async (params) => {
  const {table, object, constraint} = params;
  const insert = knex(table).insert(object);
  const update = knex.queryBuilder().update(object);
	const query = await knex.raw(`? ON CONFLICT ${constraint} DO ? returning *`, [insert, update]).get('rows').get(0);
	return query;
};

const Twitter = new twit({
  consumer_key: process.env.TWITTER_CONSUMER_KEY,
  consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
  access_token: process.env.TWITTER_ACCESS_TOKEN,
  access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
  timeout_ms: 60*1000,
});

const getStories = async (instagram) => {
	const promises = members.map(async (member, i) => {
		const response = await instagram.getStoryByUserId(userIds[i]);

		if (response) {
			const stories = response.map(each => ({
				user: member,
				reel_media_id: each.reelMediaId,
				media: each.media,
				type: 'STORY',
				taken_at: each.reelMediaTakenAt,
				media_children: JSON.stringify([{
					media: each.media,
					is_video: each.media.includes('.jpg') ? false : true,
				}]),
			}));
	
			const { length } = stories;
	
			for (i = 0; i < length; i++) {
				await upsert({
					table: 'medias',
					object: stories[i],
					constraint: '(reel_media_id)',
				});
			}
		}
	});

	await Promise.all(promises);
};

const getPosts = async (instagram) => {
	const response = await instagram.getTimeLineFeed();
	const posts = response.map(each => ({
		user: each.node.owner.username,
		reel_media_id: each.node.id,
		media: each.node.display_url,
		is_video: each.node.is_video,
		caption: each.node.edge_media_to_caption.edges[0].node.text,
		taken_at: each.node.taken_at_timestamp,
		type: 'POST',
		media_children: !each.node.edge_sidecar_to_children ? JSON.stringify([{
			media: each.node.display_url,
			is_video: each.node.is_video,
		}]) : JSON.stringify(each.node.edge_sidecar_to_children.edges.map(child => ({
			media: child.node.display_url,
			is_video: child.node.is_video,
		}))),
	}));

	const { length } = posts;

	for (i = 0; i < length; i++) {
		await upsert({
			table: 'medias',
			object: posts[i],
			constraint: '(reel_media_id)',
		});
	}
};

const downloadFile = async (url, fileName) => {  
  const filePath = path.resolve(__dirname, fileName)
  const writer = fs.createWriteStream(filePath)

  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve)
    writer.on('error', reject)
  });
};

const postMediaChunked = async (filePath) => new Promise((resolve, reject) => {
	Twitter.postMediaChunked({ file_path: filePath }, function (err, data) {
		if (err) reject(err)
		else {
			setTimeout(async () => {
				resolve(data.media_id_string)
			}, 20000);
		}
	});
});

const publish = async () => {
	const media = (await knex('medias')
		.where('is_posted', false)
		.orderBy('taken_at', 'ASC')
		.limit(1))[0];
	console.log(media);
	if (!media) return false;

	const { length } = media.media_children;

	let previousStatusId = undefined;

	for (let index = 0; index < length; index++) {
		const fileName = (media.media_children[index].is_video) ? 'media.mp4' : 'media.jpg';
		await downloadFile(media.media_children[index].media, fileName);

		const filePath = path.join(__dirname, fileName);
		const twitterMedia = await postMediaChunked(filePath);

		const result = await Twitter.post('statuses/update', {
			status: `${media.type === 'STORY' ? 'Story' : 'Post'} dari ${media.user + (media.caption ? ': ' + media.caption.substring(0, 100) + '...' : '')}`,
			media_ids: [twitterMedia],
			in_reply_to_status_id: previousStatusId});

		previousStatusId = result.data.id_str;
	}
	
	await knex('medias')
		.update({is_posted: true})
		.where('id', media.id);

	return true;
};

(async() => {
	const instagram = await Instagram.login(process.env.IG_USERNAME, process.env.IG_PASSWORD);

	await getPosts(instagram);
	await getStories(instagram);
	await publish();

	setInterval(async () => {
		await getPosts(instagram);
		await getStories(instagram);
		await publish();
	}, 1000*60*1);
})();
