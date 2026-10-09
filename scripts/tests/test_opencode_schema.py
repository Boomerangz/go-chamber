import importlib.machinery
import importlib.util
import pathlib
import unittest

source = pathlib.Path(__file__).resolve().parents[1] / "opencode-schema-check"
loader = importlib.machinery.SourceFileLoader("opencode_schema_check", str(source))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)


class SchemaContractTest(unittest.TestCase):
    def test_nested_properties_keep_names_and_types(self):
        value = {"type": "object", "properties": {"model": {
            "type": "object", "properties": {"providerID": {
                "type": "string", "description": "ignored metadata"}}}}}
        result = module.slim(value)
        self.assertEqual(result["properties"]["model"]["properties"]["providerID"],
                         {"type": "string"})

    def test_required_fields_are_checked(self):
        self.assertNotEqual(module.slim({"type": "object", "required": ["parts"]}),
                            module.slim({"type": "object", "required": []}))

    def test_reference_contract_is_collected(self):
        schema = {"paths": {}, "components": {"schemas": {
            "ModelRef": {"properties": {"providerID": {
                "$ref": "#/components/schemas/Identifier"}}},
            "Identifier": {"type": "string", "minLength": 1}}}}
        old_paths, old_schemas = module.PATHS, module.SCHEMAS
        try:
            module.PATHS = []
            module.SCHEMAS = {"ModelRef": ["providerID"]}
            self.assertEqual(module.consumed(schema)["schemas"]["Identifier"],
                             {"type": "string", "minLength": 1})
        finally:
            module.PATHS, module.SCHEMAS = old_paths, old_schemas


if __name__ == "__main__":
    unittest.main()
