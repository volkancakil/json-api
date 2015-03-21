import ResponseContext from "./types/Context/ResponseContext"
import Document from "./types/Document"
import APIError from "./types/APIError"
import * as requestValidators from "./steps/http/validate-request"
import negotiateContentType from "./steps/http/negotiate-content-type"

import labelToIds from "./steps/pre-query/label-to-ids"
import parseRequestResources from "./steps/pre-query/parse-resources"
import applyTransform from "./steps/apply-transform"

import doFind from "./steps/do-query/do-find"
import doCreate from "./steps/do-query/do-create"
import doUpdate from "./steps/do-query/do-update"
import doDelete from "./steps/do-query/do-delete"

/**
 *
 */
export default function(registry) {
  let supportedExt = ["bulk"];
  /**
   *
   * @param {RequestContext} requestContext The request context that will be
   *    used by the pipeline to generate the ResponseContext for the request.
   * @param {Object} frameworkReq This should be the request object generated by
   *    the framework that you're using. But, really, it can be absolutely
   *    anything, as this pipeline won't use it for anything except passing it
   *    to user-provided functions that it calls (like transforms and id mappers).
   * @param {Object} frameworkRes Theoretically, the response objcet generated
   *     by your http framework but, like with frameworkReq, it can be anything.
   */
  return function(requestContext, frameworkReq, frameworkRes) {
    let responseContext = new ResponseContext();

    // Now, kick off the chain for generating the response.
    // We'll validate and parse the body if one is present and, if one isn't,
    // we'll throw an error if one was supposed to be (or vice-versa).
    return requestValidators.checkBodyExistence(requestContext)
      .then(() => {
        if(requestContext.hasBody) {
          return requestValidators.checkBodyIsValidJSONAPI(requestContext.body).then(() => {
            return requestValidators.checkContentType(requestContext, supportedExt).then(() => {
              return parseRequestResources(requestContext).then(() => {
                requestContext.primary = applyTransform(
                  requestContext.primary, "beforeSave", registry, frameworkReq, frameworkRes
                );
              });
            });
          });
        }
      })

      // Map label to idOrIds, if applicable.
      .then(() => {
        if(requestContext.idOrIds && requestContext.allowLabel) {
          return labelToIds(registry, frameworkReq, requestContext, responseContext);
        }
      })

      // Actually fulfill the request!
      .then(() => {
        // If we've already populated the primary resources, which is possible
        // because the label may have mapped to no id(s), we don't need to query.
        if(typeof responseContext.primary === "undefined") {
          switch(requestContext.method) {
            case "get":
              return doFind(requestContext, responseContext, registry);

            case "post":
              return doCreate(requestContext, responseContext, registry);

            case "patch":
              return doUpdate(requestContext, responseContext, registry);

            case "delete":
              return doDelete(requestContext, responseContext, registry);
          }
        }
      })

      // Add errors to the responseContext and, if necessary, convert them to
      // APIError instances. Might be needed if, e.g., the error was unexpected
      // or the user couldn't throw an APIError for compatibility with other code).
      .catch((errors) => {
        errors = (Array.isArray(errors) ? errors : [errors]).map((it) => {
          if(it instanceof APIError) {
            return it;
          }
          else {
            const status = it.status || it.statusCode || 500;
            // if the user can't throw an APIError instance but wants to signal
            // that their specific error message should be used, let them do so.
            const message = it.isJSONAPIDisplayReady ? it.message :
              "An unknown error occurred while trying to process this request.";

            return new APIError(status, undefined, message);
          }
        });
        responseContext.errors = responseContext.errors.concat(errors);
      })

      // Negotiate the content type
      .then(() => {
        let accept = requestContext.accepts;
        let usedExt = responseContext.ext;
        return negotiateContentType(accept, usedExt, supportedExt).then(
          (it) => { responseContext.contentType = it; }
        );
      })

      // apply transforms pre-send
      .then(() => {
        responseContext.primary = applyTransform(
          responseContext.primary, "beforeRender", registry, frameworkReq, frameworkRes
        );
        responseContext.included = applyTransform(
          responseContext.included, "beforeRender", registry, frameworkReq, frameworkRes
        );
      })

      .then(() => {
        if(responseContext.errors.length) {
          responseContext.status = pickStatus(responseContext.errors.map(
            (v) => Number(v.status)
          ));
          responseContext.body = new Document(responseContext.errors).get();
        }
        else {
          responseContext.body = new Document(
            responseContext.primary, responseContext.included
          ).get();
        }
        return responseContext;
      });
  };
}

/**
 * Returns the status code that best represents a set of error statuses.
 */
function pickStatus(errStatuses) {
  return errStatuses[0];
}
