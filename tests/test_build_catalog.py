import importlib.util
import io
import json
import pathlib
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "build_catalog", ROOT / "scripts" / "build_catalog.py")
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


def response(value):
    return FakeResponse(json.dumps(value).encode())


class ArcgisGeojsonProbeTest(unittest.TestCase):
    def setUp(self):
        BUILD.FAILURES.clear()
        BUILD.source_scope("impact_layers")

    @mock.patch.object(BUILD.urllib.request, "urlopen")
    def test_count_capable_but_geojson_broken_is_failure(self, urlopen):
        urlopen.side_effect = [
            response({"objectIdFieldName": "OBJECTID", "objectIds": [41]}),
            response({"error": {"code": 400, "message": "Failed to execute query."}}),
        ]

        BUILD._probe_arcgis_geojson("https://example.test/MapServer/1/query?f=geojson", "mudflow")

        self.assertEqual(len(BUILD.FAILURES), 1)
        self.assertEqual(BUILD.FAILURES[0]["what"], "layer mudflow")
        self.assertIn("GeoJSON service error 400", BUILD.FAILURES[0]["detail"])
        self.assertIn("returnIdsOnly=true", urlopen.call_args_list[0].args[0])
        self.assertIn("objectIds=41", urlopen.call_args_list[1].args[0])
        self.assertIn("f=geojson", urlopen.call_args_list[1].args[0])

    @mock.patch.object(BUILD.urllib.request, "urlopen")
    def test_one_real_geojson_feature_is_healthy(self, urlopen):
        urlopen.side_effect = [
            response({"objectIdFieldName": "FID", "objectIds": [7]}),
            response({"type": "FeatureCollection", "features": [
                {"type": "Feature", "geometry": {"type": "Point", "coordinates": [0, 0]},
                 "properties": {"FID": 7}}
            ]}),
        ]

        BUILD._probe_arcgis_geojson("https://example.test/MapServer/29/query?f=geojson", "buildings")

        self.assertEqual(BUILD.FAILURES, [])

    @mock.patch.object(BUILD.urllib.request, "urlopen")
    def test_empty_layer_is_not_a_failure(self, urlopen):
        urlopen.return_value = response({"objectIdFieldName": "FID", "objectIds": []})

        BUILD._probe_arcgis_geojson("https://example.test/MapServer/29/query?f=geojson", "empty")

        self.assertEqual(BUILD.FAILURES, [])


class NepalLayerConfigTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.layers = {
            layer["id"]: layer
            for layer in json.loads((ROOT / "events" / "nepal-floods-2026.json").read_text())["extraLayers"]
        }

    def test_copernicus_current_layer_ids(self):
        self.assertRegex(self.layers["copernicus-buildings"]["urls"][0], r"/29/query")
        self.assertRegex(self.layers["copernicus-buildings"]["urls"][1], r"/11/query")
        self.assertRegex(self.layers["copernicus-roads"]["urls"][0], r"/33/query")
        self.assertRegex(self.layers["copernicus-roads"]["urls"][1], r"/14/query")
        self.assertRegex(self.layers["copernicus-observed"]["urls"][0], r"/31/query")
        self.assertRegex(self.layers["copernicus-observed"]["urls"][1], r"/13/query")

    def test_current_unosat_and_sertit_layer_ids(self):
        self.assertRegex(self.layers["unosat-mudflow-live"]["url"], r"UNOSAT_Analysis_V2/MapServer/41/query")
        self.assertRegex(self.layers["unosat-detachment"]["url"], r"UNOSAT_Analysis_V2/MapServer/42/query")
        self.assertRegex(self.layers["sertit-flood-trace"]["url"], r"Sertit_Analysis/MapServer/3/query")
        self.assertRegex(self.layers["sertit-builtup"]["url"], r"Sertit_Analysis/MapServer/1/query")
        self.assertRegex(self.layers["sertit-roads"]["url"], r"Sertit_Analysis/MapServer/2/query")
        for layer in self.layers.values():
            self.assertNotIn("available", layer)
            self.assertNotIn("unavailableReason", layer)


if __name__ == "__main__":
    unittest.main()
