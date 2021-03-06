'use strict';
const BbPromise = require('bluebird');
const _ = require( 'lodash' );

const utils = require('./lib/utils');

module.exports = class ApiGatewayBinaryStatus {

  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.provider = this.serverless.getProvider('aws');
    this.stage = this.options.stage;

    Object.assign(this,
      utils
    );

    this.hooks = {
      'after:aws:deploy:finalize:cleanup': this.checkBinarySupportStatus.bind(this),
    };
  }

  checkBinarySupportStatus(){
    this.serverless.cli.log('[serverless-plugin-apig-binary-status] Checking binary support enabled to AWS API Gateway...');

    return BbPromise.resolve()
      .bind(this)
      .then(() => this.createTestData(this.stage))
      .then(() => new BbPromise(resolve => setTimeout(() => resolve(), 65000)))  //replace to depend on serverless-apigwy-binary
      .then(() => this.getFunctions())
      .then((funcs) => this.checkBinaryEnabled(funcs))
      .then(() => this.deleteTestData(this.stage));
  }

  getFunctions () {
    const funcs = this.serverless.service.functions;
    const validFuncs = {};

    Object.keys(funcs).forEach((fKey) => {
      funcs[fKey].events.forEach((e) => {
        if (e.http && e.http.contentHandling && funcs[fKey].checkBinaryStatus) {
          validFuncs[fKey] = funcs[fKey];
        }
      })
    });
    return validFuncs;
  }

  checkBinaryEnabled (funcs) {
    if (!Object.keys(funcs).length) {
      return;
    }

    const apigateway = new this.provider.sdk.APIGateway({
      region: this.options.region
    });

    const lambda = new this.provider.sdk.Lambda({
      region: this.options.region
    });

    const integrationResponse = {
      statusCode: '200'
    };

    const apiName = this.provider.naming.getApiGatewayName();
    const MAX_CHECK_NUM = 12;

    return this.getApiGatewayResources(apigateway, apiName)
      .then(resources => {
        integrationResponse.restApiId = resources.restApiId;

        _.mapKeys(funcs, (fValue, fKey)=>{
          let checkCount = 0;

          this.setCompressionForFunction(lambda, fValue.name, "true")
           .then(() => {
            let checkIfEnabled = (resources, fValue) => {
              const results = [];
              results.push(this.checkBinaryMediaTypes(apigateway, resources.restApiId));

              _.map(fValue.events, e => {
                if (e.http && e.http.contentHandling) {
                  integrationResponse.httpMethod = e.http.method.toUpperCase();
                  integrationResponse.resourceId = resources.items.find(
                  r => r.path === `/${e.http.path}`).id;
                  results.push(this.isContentHandlingEnabled(integrationResponse, e.http.contentHandling, apigateway));
                }
              })

              results.push(this.testBinaryEnabled(this.stage));
              return Promise.all(results)
                  .then((results) => {
                    const success = _.every( results, result => result );

                    if( success ) {
                      console.log("[serverless-plugin-apig-binary-status] binary support enabled for api gateway, enable compression for lambda function");
                    } else {
                      throw new Error("[serverless-plugin-apig-binary-status] binary support not enabled, try again...");
                    }
                  })
                  .catch(error => {
                    if (checkCount < MAX_CHECK_NUM) {
                      setTimeout( () => checkIfEnabled(resources, fValue), 5000 );
                    } else {
                      console.log("[serverless-plugin-apig-binary-status] binary support not enabled for api gateway, disable compression for lambda function");
                      this.setCompressionForFunction(lambda, fValue.name, "false");
                    }
                    checkCount = checkCount + 1;
                  });
            };

            checkIfEnabled(resources, fValue);
          });
        });
      });
  }
}
