import copy
import importlib.util
import pathlib
import unittest

path = pathlib.Path(__file__).parents[1] / 'tools/add-oxyblobs.py'
spec = importlib.util.spec_from_file_location('save_editor', path)
editor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(editor)


def fixture():
    width = height = 128
    cells = [0] * (width * height)
    for x,y in [(72,55),(48,70),(84,76)]: cells[y*width+x] = 23
    runs = []
    for value in cells:
        if runs and runs[-2] == value: runs[-1] += 1
        else: runs.extend([value,1])
    header = dict(id='old-exitsave', worldId='old', worldName='Test', name='Exit')
    store = dict(version='0.6.0', world=dict(size=dict(width=width,height=height)),
        player=dict(x=256,y=256), structures=[], meta=dict(worldId='old',worldName='Test'),
        mods=dict(entities=dict(list=[],nextId=1)))
    data = dict(store=store,matrix=runs,authorization=dict(width=width,height=height,
        sections=[[0]*256],data=[0,64]))
    return header,data


class SaveEditorTests(unittest.TestCase):
    def test_adds_three_without_mutating_input(self):
        header,data=fixture(); original=copy.deepcopy(data)
        h,new,added=editor.patch(header,data,'copy')
        self.assertEqual(data,original)
        self.assertEqual(h['worldId'],'copy')
        self.assertEqual(len(added),3)
        self.assertEqual(new['store']['mods']['entities']['nextId'],4)
        self.assertEqual(new['matrix'],data['matrix'])
        editor.validate_changes(header,data,h,new,added)
    def test_rejects_same_world_id(self):
        h,d=fixture()
        with self.assertRaises(ValueError): editor.patch(h,d,'old')
    def test_refuses_authorized_locations(self):
        h,d=fixture();d['authorization']['sections']=[[1]*256]
        with self.assertRaises(ValueError): editor.patch(h,d,'copy')
    def test_detects_unrelated_modifications(self):
        h,d=fixture();nh,nd,added=editor.patch(h,d,'copy')
        nd['store']['player']['x']+=1
        with self.assertRaises(AssertionError): editor.validate_changes(h,d,nh,nd,added)
    def test_refuses_wrong_version(self):
        h,d=fixture();d['store']['version']='0.7.0'
        with self.assertRaises(ValueError): editor.patch(h,d,'copy')

if __name__=='__main__': unittest.main()
