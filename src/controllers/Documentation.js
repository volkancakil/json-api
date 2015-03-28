import Q from "q";
import templating from "url-template";
import jade from "jade";
import Negotiator from "negotiator";
import path from "path";

import Response from "../types/HTTP/Response";
import Document from "../types/Document";
import Collection from "../types/Collection";
import Resource from "../types/Resource";

export default class DocumentationController {
  constructor(registry, apiInfo, templatePath) {
    const defaultTempPath = "../../../templates/documentation.jade";
    this.template = templatePath || path.resolve(__dirname, defaultTempPath);
    this.registry = registry;

    // compute template data on construction
    // (it never changes, so this makes more sense than doing it per request)
    let data = Object.assign({}, apiInfo);
    data.resourcesMap = {};

    // Store in the resourcesMap the info object about each type,
    // as returned by @getTypeInfo.
    this.registry.types().forEach((type) => {
      data.resourcesMap[type] = this.getTypeInfo(type);
    });

    this.templateData = data;
  }

  handle(request) {
    let response = new Response();
    let negotiator = new Negotiator({headers: {accept: request.accepts}});
    let contentType = negotiator.mediaType(["text/html", "application/vnd.api+json"]);

    // set content type as negotiated
    response.contentType = contentType;

    if(contentType === "text/html") {
      response.body = jade.renderFile(this.template, this.templateData);
    }

    else {
      // Create a collection of "jsonapi-descriptions" from the templateData
      let descriptionResources = new Collection();
      for(let type in this.templateData.resourcesMap) {
        let typeInfo = this.templateData.resourcesMap[type];

        // Build attributes for this description resource.
        let attrs = Object.assign({}, typeInfo);
        attrs.fields = [];
        attrs.name = {
          "singular": attrs.singularName,
          "plural": attrs.pluralName,
          "model": attrs.name
        };

        delete attrs.schema;
        delete attrs.childTypes;
        delete attrs.singularName;
        delete attrs.pluralName;

        for(let path in typeInfo.schema) {
          let fieldDesc = {
            name: path,
            friendlyName: typeInfo.schema[path].friendlyName,
            kind: typeInfo.schema[path].type,
            description: typeInfo.schema[path].description,
            requirements: {
              required: !!typeInfo.schema[path].required
            }
          };

          if(typeInfo.schema[path].enumValues) {
            fieldDesc.oneOf = typeInfo.schema[path].enumValues;
          }

          let fieldDefault = typeInfo.schema[path].default;
          fieldDesc.default = fieldDefault === "(auto generated)" ? "__AUTO__" : fieldDefault;

          attrs.fields.push(fieldDesc);
        }

        let typeDescription = new Resource("jsonapi-descriptions", type, attrs);
        descriptionResources.add(typeDescription);
      }

      response.body = (new Document(descriptionResources)).get(true);
    }

    return Q(response);
  }

  // Clients can extend this if, say, the adapter can't infer
  // as much info about the models' structure as they would like.
  getTypeInfo(type) {
    const adapter   = this.registry.adapter(type);
    const modelName = adapter.constructor.getModelName(type);
    const model     = adapter.getModel(modelName);

    // Combine the docs in the Resource description with the standardized schema
    // from the adapter in order to build the final schema for the template.
    const info = this.registry.info(type);
    const schema = adapter.constructor.getStandardizedSchema(model);
    const toTitleCase = (v) => v.charAt(0).toUpperCase() + v.slice(1);
    const toFriendlyName = (v) => toTitleCase(v).split(/(?=[A-Z])/).join(" ");

    if(info && info.fields) {
      for(let path in schema) {
        if(info.fields[path] && info.fields[path].description) {
          schema[path].description = info.fields[path].description;
        }
        if(info.fields[path] && info.fields[path].friendlyName) {
          schema[path].friendlyName = info.fields[path].friendlyName;
        }
        else {
          schema[path].friendlyName = toFriendlyName(path);
        }
      }
    }
    // Other info
    let result = {
      name: modelName,
      singularName: toFriendlyName(modelName),
      pluralName: type.split("-").map(toTitleCase).join(" "),
      schema: schema,
      parentType: this.registry.parentType(type),
      childTypes: adapter.constructor.getChildTypes(model)
    };

    let defaultIncludes = this.registry.defaultIncludes(type);
    if(defaultIncludes) result.defaultIncludes = defaultIncludes;

    if(info && info.example) result.example = info.example;
    if(info && info.description) result.description = info.description;

    return result;
  }
}


