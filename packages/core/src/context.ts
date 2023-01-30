import {
  Events,
  getTimestampSec,
  Logger,
  RuntimeInfo,
  SkyWayError,
} from '@skyway-sdk/common';
import model, { MemberType } from '@skyway-sdk/model';
import { RtcApiClient } from '@skyway-sdk/rtc-api-client';
import { SkyWayAuthToken } from '@skyway-sdk/token';

import { SkyWayChannelImpl } from './channel';
import { ContextConfig, SkyWayConfigOptions } from './config';
import { errors } from './errors';
import { RemoteMemberImplInterface } from './member/remoteMember';
import { SkyWayPlugin } from './plugin/interface/plugin';
import { registerPersonPlugin } from './plugin/internal/person/plugin';
import { UnknownPlugin } from './plugin/internal/unknown/plugin';
import { createError, getRuntimeInfo } from './util';
import { PACKAGE_VERSION } from './version';

const log = new Logger('packages/core/src/context.ts');

export class SkyWayContext {
  /**@internal */
  static version = PACKAGE_VERSION;

  /**
   * @description [japanese] Contextの作成
   */
  static async Create(
    authTokenString: string,
    configOptions: Partial<SkyWayConfigOptions> = {}
  ) {
    const config = new ContextConfig(configOptions);
    Logger.level = config.log.level;
    Logger.format = config.log.format;

    const token = SkyWayAuthToken.Decode(authTokenString);

    const { osName, osVersion, browserName, browserVersion } = getRuntimeInfo();
    const runtime = {
      sdkName: 'core',
      sdkVersion: this.version,
      osName,
      osVersion,
      browserName,
      browserVersion,
    };
    const endpoint = {
      rapi: config.rtcApi.domain,
      signaling: config.signalingService.domain,
      ice: config.iceParamServer.domain,
    };

    log.info('core sdk spawned', {
      operationName: 'SkyWayContext.Create',
      runtime,
      endpoint,
      config,
      token,
    });

    try {
      const api = await RtcApiClient.Create({
        appId: token.scope.app.id,
        token: authTokenString,
        log: config.log,
        rtcApi: config.rtcApi,
      });
      return new SkyWayContext(api, config, token, { endpoint, runtime });
    } catch (error: any) {
      throw createError({
        operationName: 'SkyWayContext.Create',
        info: errors.connectRtcApiFailed,
        error,
        path: log.prefix,
      });
    }
  }

  readonly appId: string;
  disposed = false;

  /**@internal */
  public plugins: SkyWayPlugin[] = [];
  private _unknownPlugin = new UnknownPlugin();
  /**@private */
  readonly _api: RtcApiClient;
  private _authTokenString: string;
  /**seconds */
  private _reminderSec = this.config.token.updateReminderSec;
  private tokenUpdateReminderTimer: any;
  private tokenExpiredTimer: any;

  private _events = new Events();
  /**
   * @description [japanese] トークンの期限がまもなく切れる
   * @example
   * context.onTokenUpdateReminder.add(() => {
      context.updateAuthToken(tokenString);
    });
   */
  readonly onTokenUpdateReminder = this._events.make<void>();
  /**
   * @description [japanese] トークンの期限切れ。トークンを更新するまでサービスを利用できない
   */
  readonly onTokenExpired = this._events.make<void>();
  /**
   * @description [japanese] 回復不能なエラー。インターネット接続状況を確認した上で別のインスタンスを作り直す必要がある
   */
  readonly onFatalError = this._events.make<SkyWayError>();

  /**@private */
  readonly _onTokenUpdated = this._events.make<string>();
  /**@private */
  readonly _onDisposed = this._events.make<void>();

  /**@private */
  constructor(
    api: RtcApiClient,
    public config: ContextConfig,
    public authToken: SkyWayAuthToken,
    /**@internal */
    readonly info: { endpoint: EndpointInfo; runtime: RuntimeInfo }
  ) {
    this._authTokenString = authToken.tokenString!;
    this.appId = this.authToken.scope.app.id;

    this._setTokenExpireTimer();

    registerPersonPlugin(this);

    this._api = api;
    this._api.onFatalError.once((error) => {
      log.error('onFatalError', { appId: this.appId, error });
      this.onFatalError.emit(
        createError({
          operationName: 'SkyWayContext._api.onFatalError',
          context: this,
          info: errors.rtcApiFatalError,
          error,
          path: log.prefix,
        })
      );
      this.dispose();
    });
  }

  get authTokenString() {
    return this._authTokenString;
  }

  private _setTokenExpireTimer() {
    // seconds
    const now = getTimestampSec();
    const expiresInSec = this.authToken.exp - now;
    if (expiresInSec < 0) {
      throw createError({
        operationName: 'SkyWayContext._setTokenExpireTimer',
        context: this,
        info: errors.invalidExpireTokenValue,
        path: log.prefix,
        payload: { exp: this.authToken.exp, now },
      });
    }

    if (this.tokenUpdateReminderTimer) {
      clearTimeout(this.tokenUpdateReminderTimer);
    }
    const tokenExpireReminderTimeSec = expiresInSec - this._reminderSec;
    if (tokenExpireReminderTimeSec < 0) {
      throw createError({
        operationName: 'SkyWayContext._setTokenExpireTimer',
        context: this,
        info: errors.invalidRemindExpireTokenValue,
        path: log.prefix,
        payload: { expiresInSec, reminderSec: this._reminderSec },
      });
    }
    log.debug('_setTokenExpireTimer', {
      expiresInSec,
      tokenExpireReminderTimeSec,
    });

    this.tokenUpdateReminderTimer = setTimeout(() => {
      log.debug('tokenUpdateReminder', { appid: this.appId });
      this.onTokenUpdateReminder.emit();
    }, tokenExpireReminderTimeSec * 1000);

    if (this.tokenExpiredTimer) {
      clearTimeout(this.tokenExpiredTimer);
    }
    this.tokenExpiredTimer = setTimeout(() => {
      log.debug('tokenExpired', { appid: this.appId });
      this.onTokenExpired.emit();
    }, expiresInSec * 1000);
  }

  /**
   * @description [japanese] トークンの更新
   */
  async updateAuthToken(token: string) {
    const newToken = SkyWayAuthToken.Decode(token);
    log.info(
      { operationName: 'SkyWayContext.updateAuthToken' },
      { oldToken: this.authToken, newToken }
    );

    if (newToken.scope.app.id !== this.appId) {
      throw createError({
        operationName: 'SkyWayContext.updateAuthToken',
        context: this,
        info: errors.invalidTokenAppId,
        path: log.prefix,
        payload: { invalid: this.authToken.scope.app.id, expect: this.appId },
      });
    }

    this._authTokenString = token;
    this.authToken = newToken;

    this._onTokenUpdated.emit(token);
    this._setTokenExpireTimer();

    await this._api.updateAuthToken(token);
  }

  /**
   * @description [japanese] プラグインの登録
   */
  registerPlugin(plugin: SkyWayPlugin) {
    if (this.plugins.find((p) => p.subtype === plugin.subtype)) {
      return;
    }
    plugin._attachContext(this);
    this.plugins.push(plugin);
  }

  /**@private */
  _createRemoteMember(
    channel: SkyWayChannelImpl,
    memberDto: model.Member
  ): RemoteMemberImplInterface {
    const exist = channel._getMember(memberDto.id);
    if (exist) {
      return exist;
    }

    log.debug('createRemoteMember', { memberDto });

    memberDto.type = memberDto.type.toLowerCase() as MemberType;
    memberDto.subtype = memberDto.subtype.toLowerCase();

    let plugin = this.plugins.find((p) => p.subtype === memberDto.subtype);
    if (!plugin) {
      plugin = this._unknownPlugin;
      // 悪意のあるユーザが未知のsubtypeを使用した際に無視するためにthrowしない
      log.error(
        createError({
          operationName: 'SkyWayContext._createRemoteMember',
          context: this,
          info: errors.unknownRemoteMemberType,
          path: log.prefix,
          payload: { memberDto },
        })
      );
    }
    const member = plugin._createRemoteMember(channel, memberDto);
    return member;
  }

  /**
   * @description [japanese] Contextの利用を終了し次のリソースを解放する
   * - イベントリスナー
   * - バックエンドサーバとの通信
   * - Contextを参照する全Channelインスタンス
   */
  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    log.debug('disposed', { appid: this.appId });

    clearTimeout(this.tokenUpdateReminderTimer);

    this._onDisposed.emit();
    this._events.dispose();

    this._api.close();
  }
}

/**@internal */
export interface EndpointInfo {
  rapi: string;
  signaling: string;
  ice: string;
}
