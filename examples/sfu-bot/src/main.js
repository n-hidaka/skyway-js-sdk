import {

  SkyWayChannel,
  SkyWayContext,
  SkyWayStreamFactory } from
'@skyway-sdk/core';
import { SfuBotMember, SfuBotPlugin } from '@skyway-sdk/sfu-bot';

import { getToken } from './skyway-auth-token';

void (async () => {
  const localVideo = document.getElementById('local-video');
  const buttonArea = document.getElementById('button-area');
  const remoteMediaArea = document.getElementById('remote-media-area');
  const channelNameInput = document.getElementById(
    'channel-name'
  );
  const myId = document.getElementById('my-id');
  const joinButton = document.getElementById('join');

  const { audio, video } =
  await SkyWayStreamFactory.createMicrophoneAudioAndCameraStream();
  video.attach(localVideo);
  await localVideo.play();

  joinButton.onclick = async () => {
    if (channelNameInput.value === '') return;

    const plugin = new SfuBotPlugin();
    const token = await getToken('*', '*');
    const context = await SkyWayContext.Create(token);
    context.registerPlugin(plugin);
    const channel = await SkyWayChannel.FindOrCreate(context, {
      name: channelNameInput.value
    });
    if (channel.bots.length === 0) {
      await plugin.createBot(channel);
    }

    const bot = channel.bots[0] ?? (
    await plugin.createBot(channel));

    const me = await channel.join();

    myId.textContent = me.id;

    {
      const publication = await me.publish(audio);
      await bot.startForwarding(publication);
    }
    {
      const publication = await me.publish(video, {
        encodings: [
        { maxBitrate: 80_000, id: 'low' },
        { maxBitrate: 400_000, id: 'high' }]

      });
      await bot.startForwarding(publication);
    }

    const createSubscribeButton = (publication) => {
      if (
      publication.publisher.subtype !== SfuBotMember.subtype ||
      publication.origin.publisher.id === me.id)
      {
        return;
      }

      const subscribeButton = document.createElement('button');
      subscribeButton.textContent = `${publication.publisher.id}: ${publication.contentType}`;
      buttonArea.appendChild(subscribeButton);

      subscribeButton.onclick = async () => {
        const { stream, subscription } = await me.subscribe(publication.id);

        switch (stream.contentType) {
          case 'video':
            {
              const elm = document.createElement('video');
              elm.playsInline = true;
              elm.autoplay = true;
              stream.attach(elm);
              elm.onclick = () => {
                if (subscription.preferredEncoding === 'low') {
                  subscription.changePreferredEncoding('high');
                } else {
                  subscription.changePreferredEncoding('low');
                }
              };
              remoteMediaArea.appendChild(elm);
            }
            break;
          case 'audio':
            {
              const elm = document.createElement('audio');
              elm.controls = true;
              elm.autoplay = true;
              stream.attach(elm);
              remoteMediaArea.appendChild(elm);
            }
            break;
        }
      };
    };

    channel.publications.forEach(createSubscribeButton);
    channel.onStreamPublished.add((e) => createSubscribeButton(e.publication));
  };
})();
